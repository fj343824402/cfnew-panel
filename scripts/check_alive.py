import base64
import concurrent.futures
import json
import os
import subprocess
import time
import urllib.parse
import requests

SUB_URL = os.environ["TEAM_SUB_URL"].strip()
MAX_KEEP = 350        # 最多保留前 350 个延迟最低的活节点
TEST_URL = "https://www.youtube.com/generate_204"
TIMEOUT_MS = 2500     # 2.5 秒内能连上 YouTube 才算活节点
WORKERS = 80          # 80 并发测速


def decode_base64_lines(text):
    text = text.strip()
    if "://" in text and "\n" in text:
        return [l.strip() for l in text.splitlines() if "://" in l]
    cleaned = "".join(text.split()).replace("-", "+").replace("_", "/")
    cleaned += "=" * (-len(cleaned) % 4)
    raw = base64.b64decode(cleaned).decode("utf-8", errors="ignore")
    return [l.strip() for l in raw.splitlines() if "://" in l]


def tag_node(uri, new_name):
    """给节点临时打上唯一序号别名，测完再还原原节点"""
    low = uri.lower()
    try:
        if low.startswith("vmess://") and "@" not in uri:
            b64 = uri.split("://", 1)[1].strip()
            b64 = b64.replace("-", "+").replace("_", "/")
            b64 += "=" * (-len(b64) % 4)
            obj = json.loads(base64.b64decode(b64).decode("utf-8"))
            if not obj.get("add") or not (1 <= int(obj.get("port", 0)) <= 65535):
                return None
            obj["ps"] = new_name
            return "vmess://" + base64.b64encode(json.dumps(obj).encode()).decode()
        if low.startswith("ssr://"):
            return None  # 跳过老旧 ssr，减少 mihomo 解析异常
        parsed = urllib.parse.urlsplit(uri)
        if not parsed.hostname or not parsed.port or not (1 <= parsed.port <= 65535):
            return None
        base_uri = urllib.parse.urlunsplit(parsed._replace(fragment=""))
        return f"{base_uri}#{new_name}"
    except Exception:
        return None


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

    os.makedirs("runtime", exist_ok=True)
    nodes_file = os.path.abspath("runtime/raw_nodes.txt")
    with open(nodes_file, "w", encoding="utf-8") as f:
        f.write(base64.b64encode("\n".join(tagged_lines).encode()).decode())

    cfg = {
        "mixed-port": 7890,
        "mode": "rule",
        "log-level": "silent",
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
        for _ in range(40):
            time.sleep(0.5)
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

        print(f"Mihomo loaded {len(loaded_names)} valid nodes, testing YouTube 204...")

        def check_one(name):
            try:
                r = requests.get(
                    f"http://127.0.0.1:9090/proxies/{name}/delay",
                    params={"url": TEST_URL, "timeout": TIMEOUT_MS},
                    timeout=(2, TIMEOUT_MS / 1000 + 2),
                )
                if r.status_code == 200:
                    d = r.json().get("delay")
                    if isinstance(d, int) and d > 0:
                        return (d, orig_map[name])
            except Exception:
                pass
            return None

        alive = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for res in ex.map(check_one, loaded_names):
                if res:
                    alive.append(res)

        alive.sort(key=lambda x: x[0])
        selected = [uri for _, uri in alive[:MAX_KEEP]]
        print(f"Alive YouTube nodes: {len(alive)}, keeping top {len(selected)}")

        os.makedirs("alive_out", exist_ok=True)
        out_b64 = base64.b64encode("\n".join(selected).encode()).decode()
        with open("alive_out/alive.txt", "w", encoding="utf-8") as f:
            f.write(out_b64)
        with open("alive_out/stats.json", "w", encoding="utf-8") as f:
            json.dump(
                {"checked": len(loaded_names), "alive": len(alive), "kept": len(selected)},
                f,
                indent=2,
            )
    finally:
        proc.terminate()
        proc.wait(timeout=5)


if __name__ == "__main__":
    main()
