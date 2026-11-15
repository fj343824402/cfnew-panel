import base64
import concurrent.futures
import json
import os
import re
import subprocess
import time
import urllib.parse
import requests

SUB_URL = os.environ["TEAM_SUB_URL"].strip()
MAX_KEEP = 350        # 最多保留前 350 个延迟最低的活节点
TEST_URL = "https://www.gstatic.com/generate_204"
TIMEOUT_MS = 2500
WORKERS = 80

VALID_SS_CIPHERS = {
    "aes-128-gcm", "aes-192-gcm", "aes-256-gcm",
    "chacha20-ietf-poly1305", "xchacha20-ietf-poly1305",
    "aes-128-cfb", "aes-192-cfb", "aes-256-cfb",
    "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
    "rc4-md5", "chacha20-ietf", "chacha20",
    "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305", "none", "plain",
}


def b64_decode_str(text):
    cleaned = "".join(text.split()).replace("-", "+").replace("_", "/")
    cleaned += "=" * (-len(cleaned) % 4)
    return base64.b64decode(cleaned).decode("utf-8", errors="ignore")


def decode_base64_lines(text):
    text = text.strip()
    if "://" in text and "\n" in text:
        return [l.strip() for l in text.splitlines() if "://" in l]
    raw = b64_decode_str(text)
    return [l.strip() for l in raw.splitlines() if "://" in l]


def is_valid_ss_uri(uri):
    try:
        body = uri.split("://", 1)[1].split("#", 1)[0].split("?", 1)[0]
        if "@" in body:
            userinfo = body.split("@", 1)[0]
            if ":" not in userinfo:
                userinfo = b64_decode_str(userinfo)
            method = userinfo.split(":", 1)[0].strip().lower()
        else:
            decoded = b64_decode_str(body)
            method = decoded.split(":", 1)[0].strip().lower()
        return method in VALID_SS_CIPHERS
    except Exception:
        return False


def tag_node(uri, new_name):
    low = uri.lower()
    try:
        if low.startswith("vmess://") and "@" not in uri.split("#", 1)[0]:
            obj = json.loads(b64_decode_str(uri.split("://", 1)[1].split("#", 1)[0]))
            if str(obj.get("net", "")).lower() in ("h2", "http") or isinstance(obj.get("path"), list):
                return None
            if not obj.get("add") or not (1 <= int(obj.get("port", 0)) <= 65535):
                return None
            obj["ps"] = new_name
            return "vmess://" + base64.b64encode(json.dumps(obj).encode()).decode()
        if low.startswith("ssr://"):
            return None
        if low.startswith("ss://") and not is_valid_ss_uri(uri):
            return None
        parsed = urllib.parse.urlsplit(uri)
        if re.search(r"(?:^|&)(?:type|net)=(?:h2|http)(?:&|$)", parsed.query, re.I):
            return None
        if not parsed.hostname or not parsed.port or not (1 <= parsed.port <= 65535):
            return None
        base_uri = urllib.parse.urlunsplit(parsed._replace(fragment=""))
        return f"{base_uri}#{new_name}"
    except Exception:
        return None


def test_batch(tagged_batch, orig_map):
    os.makedirs("runtime", exist_ok=True)
    nodes_file = os.path.abspath("runtime/raw_nodes.txt")
    with open(nodes_file, "w", encoding="utf-8") as f:
        f.write(base64.b64encode("\n".join(tagged_batch).encode()).decode())

    cfg = {
        "mixed-port": 7890,
        "mode": "rule",
        "log-level": "error",
        "external-controller": "127.0.0.1:9090",
        "proxy-providers": {
            "pool": {
                "type": "file",
                "path": nodes_file,
                "health-check": {"enable": False, "interval": 300, "url": TEST_URL},
            }
        },
        "proxy-groups": [{"name": "all", "type": "select", "use": ["pool"]}],
        "rules": ["MATCH,all"],
    }
    cfg_file = os.path.abspath("runtime/config.json")
    with open(cfg_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f)

    proc = subprocess.Popen(["./mihomo", "-d", "runtime", "-f", cfg_file])
    try:
        loaded_names = []
        for _ in range(12):
            time.sleep(0.5)
            if proc.poll() is not None:
                return False, []
            try:
                r = requests.get("http://127.0.0.1:9090/providers/proxies/pool", timeout=2)
                if r.status_code == 200:
                    loaded_names = [
                        p["name"] for p in r.json().get("proxies", []) if p.get("name") in orig_map
                    ]
                    if loaded_names:
                        break
            except Exception:
                pass

        if not loaded_names:
            return False, []

        sample_errors = []

        def check_one(name):
            try:
                r = requests.get(
                    f"http://127.0.0.1:9090/providers/proxies/pool/{name}/healthcheck",
                    params={"url": TEST_URL, "timeout": TIMEOUT_MS},
                    timeout=(2, TIMEOUT_MS / 1000 + 2),
                )
                if r.status_code == 200:
                    d = r.json().get("delay")
                    if isinstance(d, int) and d > 0:
                        return (d, orig_map[name])
                elif len(sample_errors) < 3:
                    sample_errors.append(f"{r.status_code}: {r.text[:100]}")
            except Exception as e:
                if len(sample_errors) < 3:
                    sample_errors.append(str(e)[:100])
            return None

        alive = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for res in ex.map(check_one, loaded_names):
                if res:
                    alive.append(res)
        if not alive and sample_errors:
            print(f"Batch {len(loaded_names)} nodes -> 0 alive. Samples: {sample_errors}")
        return True, alive
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def main():
    print("Fetching raw subscription...")
    resp = requests.get(SUB_URL, timeout=30, headers={"User-Agent": "v2rayN/6.45"})
    resp.raise_for_status()
    raw_uris = decode_base64_lines(resp.text)
    print(f"Fetched {len(raw_uris)} raw URIs")

    tagged_lines = []
    orig_map = {}
    for idx, uri in enumerate(raw_uris):
        name = f"n_{idx}"
        tagged = tag_node(uri, name)
        if tagged:
            tagged_lines.append(tagged)
            orig_map[name] = uri

    print(f"Filtered valid URIs: {len(tagged_lines)}")
    ok, alive = test_batch(tagged_lines, orig_map)

    if not ok:
        print("Full batch failed to load in Mihomo, falling back to 200-node chunks...")
        alive = []
        for i in range(0, len(tagged_lines), 200):
            chunk = tagged_lines[i : i + 200]
            c_ok, c_alive = test_batch(chunk, orig_map)
            if c_ok:
                alive.extend(c_alive)
            else:
                for j in range(0, len(chunk), 40):
                    sub_ok, sub_alive = test_batch(chunk[j : j + 40], orig_map)
                    if sub_ok:
                        alive.extend(sub_alive)

    alive.sort(key=lambda x: x[0])
    selected = [uri for _, uri in alive[:MAX_KEEP]]
    print(f"Alive nodes: {len(alive)}, keeping top {len(selected)}")
    if not selected:
        raise RuntimeError("No alive nodes found, aborting so alive.txt is not overwritten with empty.")

    os.makedirs("alive_out", exist_ok=True)
    out_b64 = base64.b64encode("\n".join(selected).encode()).decode()
    with open("alive_out/alive.txt", "w", encoding="utf-8") as f:
        f.write(out_b64)
    with open("alive_out/stats.json", "w", encoding="utf-8") as f:
        json.dump(
            {"raw": len(raw_uris), "filtered": len(tagged_lines), "alive": len(alive), "kept": len(selected)},
            f,
            indent=2,
        )


if __name__ == "__main__":
    main()
