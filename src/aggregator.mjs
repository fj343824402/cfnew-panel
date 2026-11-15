// src/aggregator.mjs (Node 22+ ESM，支持 GitHub 自动寻源 + 日期模板 + 多源去重)

const DEFAULT_PUBLIC_SUB_URLS = [
  // 可选：在这里固定写入你信任的公开源或日期模板，例如：
  // "https://example.com/nodes/{YYYY}/{MM}/{YYYYMMDD}.txt",
];

// 自动探测的仓库常见订阅文件名
const CANDIDATE_FILENAMES = [
  "sub.txt",
  "sub",
  "nodes.txt",
  "base64.txt",
  "v2ray.txt",
  "all.txt",
];

// GitHub 搜索关键词（只搜公开标注免费分享、且近期刚更新的仓库）
const GITHUB_SEARCH_QUERIES = [
  "free v2ray nodes sub in:name,description,readme",
  "vless trojan free nodes in:name,description",
];

const VALID_PROTO_REGEX = /^(vless|vmess|trojan|ss|ssr|hysteria|hysteria2|hy2|tuic):\/\//i;

// 节点缓存（5 分钟） & 自动发现列表缓存（30 分钟）
let cachedSub = { base64: "", stats: null, expireAt: 0 };
let cachedDiscovery = { urls: [], repos: [], expireAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_TTL_MS = 30 * 60 * 1000;

function splitEnvUrls(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("http://") || s.startsWith("https://"));
}

// 展开日期模板（同时生成今天和昨天的链接，防止跨时区源站还没更新）
function expandDateTemplates(urls) {
  const expanded = [];
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400 * 1000);
  const dates = [now, yesterday];

  for (const u of urls) {
    if (!/\{(YYYY|MM|DD|YYYYMMDD)\}/.test(u)) {
      expanded.push(u);
      continue;
    }
    for (const d of dates) {
      const yyyy = String(d.getUTCFullYear());
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      expanded.push(
        u.replaceAll("{YYYY}", yyyy)
          .replaceAll("{MM}", mm)
          .replaceAll("{DD}", dd)
          .replaceAll("{YYYYMMDD}", `${yyyy}${mm}${dd}`)
      );
    }
  }
  return Array.from(new Set(expanded));
}

function decodeBase64Safe(text) {
  const cleaned = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (cleaned.length % 4)) % 4;
  return Buffer.from(cleaned + "=".repeat(padLen), "base64").toString("utf8");
}

function isValidNodeUri(line) {
  if (!VALID_PROTO_REGEX.test(line)) return false;
  const scheme = line.split(":", 1)[0].toLowerCase();
  const body = line.split("://", 2)[1] || "";
  const mainPart = body.split("#", 1)[0];
  if (!mainPart || /\s/.test(mainPart)) return false;
  if (scheme === "vmess" || scheme === "ssr") {
    return mainPart.length >= 16;
  }
  return mainPart.includes(":") && (mainPart.includes("@") || (scheme === "ss" && mainPart.length >= 16));
}

function parseNodes(rawText) {
  const trimmed = (rawText || "").trim();
  if (!trimmed) return [];

  let lines = [];
  if (VALID_PROTO_REGEX.test(trimmed)) {
    lines = trimmed.split(/\r?\n/);
  } else {
    try {
      const decoded = decodeBase64Safe(trimmed);
      lines = decoded.split(/\r?\n/);
    } catch {
      return [];
    }
  }

  return lines.map((line) => line.trim()).filter(isValidNodeUri);
}

function safeDecodeURI(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function getNodeDedupKey(node) {
  if (node.toLowerCase().startsWith("vmess://") || node.toLowerCase().startsWith("ssr://")) {
    return node;
  }
  const hashIdx = node.indexOf("#");
  return hashIdx !== -1 ? node.slice(0, hashIdx) : node;
}

async function fetchText(url, headers = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 从 GitHub 公开搜索 API 自动发现最近更新的免费节点仓库与订阅链接
async function autoDiscoverPublicUrls(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedDiscovery.urls.length && now < cachedDiscovery.expireAt) {
    return cachedDiscovery;
  }

  const ghHeaders = {
    "User-Agent": "cfnew-sub-aggregator",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  }

  const repoMap = new Map();
  // 搜索最近 7 天内更新过的公开仓库
  const sinceDate = new Date(now - 7 * 86400 * 1000).toISOString().slice(0, 10);

  await Promise.all(
    GITHUB_SEARCH_QUERIES.map(async (q) => {
      const apiUrl =
        `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} pushed:>=${sinceDate}`)}` +
        `&sort=updated&order=desc&per_page=8`;
      const jsonText = await fetchText(apiUrl, ghHeaders, 5000);
      if (!jsonText) return;
      try {
        const data = JSON.parse(jsonText);
        for (const repo of data.items || []) {
          if (repo.full_name && repo.default_branch) {
            repoMap.set(repo.full_name, repo.default_branch);
          }
        }
      } catch {}
    })
  );

  // 取前 8 个最活跃的仓库进行探测
  const topRepos = Array.from(repoMap.entries()).slice(0, 8);
  const discoveredUrls = new Set();

  await Promise.all(
    topRepos.map(async ([fullName, branch]) => {
      const baseRaw = `https://raw.githubusercontent.com/${fullName}/${branch}`;

      // 1) 探测常见固定文件名
      for (const fname of CANDIDATE_FILENAMES) {
        discoveredUrls.add(`${baseRaw}/${fname}`);
      }

      // 2) 抓取 README.md，正则嗅探里面贴出的外部 Raw / 订阅链接
      const readme = await fetchText(`${baseRaw}/README.md`, { "User-Agent": "cfnew-sub-aggregator" }, 4000);
      if (readme) {
        const matches = readme.match(/https?:\/\/[^\s<>"')`\]]+/g) || [];
        let extracted = 0;
        for (const link of matches) {
          if (extracted >= 5) break;
          // 排除图片、网页和 GitHub 页面本身，保留像订阅文件的链接
          if (/\.(png|jpg|jpeg|gif|svg|webp|ico|md|html)$/i.test(link)) continue;
          if (/^https?:\/\/(github\.com|t\.me|telegram\.me|youtube\.com|twitter\.com|x\.com)\//i.test(link)) continue;
          if (/(raw\.githubusercontent\.com|gist\.githubusercontent\.com|\.txt\b|sub|node|v2ray|base64)/i.test(link)) {
            discoveredUrls.add(link);
            extracted++;
          }
        }
      }
    })
  );

  cachedDiscovery = {
    urls: Array.from(discoveredUrls),
    repos: topRepos.map(([name]) => name),
    expireAt: now + DISCOVERY_TTL_MS,
  };
  return cachedDiscovery;
}

async function fetchSingleSource(url, label, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "v2rayN/6.45" },
    });
    if (!res.ok) {
      return { label, url, ok: false, status: res.status, nodes: [] };
    }
    const text = await res.text();
    const nodes = parseNodes(text);
    return { label, url, ok: nodes.length > 0, count: nodes.length, nodes };
  } catch (err) {
    return { label, url, ok: false, error: err?.name || "fetch_error", nodes: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildAggregatedSub({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedSub.base64 && now < cachedSub.expireAt) {
    return { base64: cachedSub.base64, stats: { ...cachedSub.stats, fromCache: true } };
  }

  const ownUrls = splitEnvUrls(process.env.OWN_SUB_URLS);
  const manualPublicUrls = expandDateTemplates(
    Array.from(new Set([...DEFAULT_PUBLIC_SUB_URLS, ...splitEnvUrls(process.env.PUBLIC_SUB_URLS)]))
  );

  // 默认开启自动寻源（如想关闭，在 Vercel 环境变量设 AUTO_DISCOVER=0）
  const enableAuto = process.env.AUTO_DISCOVER !== "0";
  const discovery = enableAuto ? await autoDiscoverPublicUrls(forceRefresh) : { urls: [], repos: [] };

  const allPublicUrls = Array.from(new Set([...manualPublicUrls, ...discovery.urls]));

  const tasks = [
    ...ownUrls.map((u, idx) => fetchSingleSource(u, `own_${idx + 1}`, 8000)),
    ...allPublicUrls.map((u, idx) => fetchSingleSource(u, `public_${idx + 1}`, 5000)),
  ];

  const results = await Promise.all(tasks);

  const uniqueMap = new Map();
  let filteredAds = 0;

  for (const res of results) {
    for (const node of res.nodes) {
      const remark = safeDecodeURI(node.split("#")[1] || "");
      if (/到期时间|剩余流量|官网|重置|套餐|禁止|群组|频道|TG群|失联/i.test(remark)) {
        filteredAds++;
        continue;
      }
      const key = getNodeDedupKey(node);
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, node);
      }
    }
  }

  const finalNodes = Array.from(uniqueMap.values());
  const base64 = Buffer.from(finalNodes.join("\n"), "utf8").toString("base64");

  // debug 只列出抓取成功的源或自己的源，避免几十个 404 探测文件名刷屏
  const visibleSources = results.filter((r) => r.label.startsWith("own_") || r.count > 0);

  const stats = {
    fromCache: false,
    updatedAt: new Date(now).toISOString(),
    totalUniqueNodes: finalNodes.length,
    filteredAdNodes: filteredAds,
    autoDiscoveredRepos: discovery.repos,
    probedCandidateUrls: allPublicUrls.length,
    effectiveSources: visibleSources.map((r) => ({
      label: r.label,
      count: r.count || 0,
      ...(r.label.startsWith("public_") ? { url: r.url } : {}),
    })),
  };

  cachedSub = {
    base64,
    stats,
    expireAt: now + CACHE_TTL_MS,
  };

  return { base64, stats };
}
