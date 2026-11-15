// src/aggregator.mjs (Node 22+ ESM，零第三方依赖)

// 1. 可以在代码里写默认公开源，但更推荐部署后在 Vercel 环境变量 PUBLIC_SUB_URLS 里随时增删！
const DEFAULT_PUBLIC_SUB_URLS = [
  // "https://raw.githubusercontent.com/你的公开源1/main/sub.txt",
];

// 允许保留的代理协议（兼容你的 Mihomo 下载器）
const VALID_PROTO_REGEX = /^(vless|vmess|trojan|ss|ssr|hysteria|hysteria2|hy2|tuic):\/\//i;

// 服务端内存缓存（默认 5 分钟，避免 30 人同时点更新把源站刷挂）
let cachedSub = { base64: "", stats: null, expireAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

function splitEnvUrls(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("http://") || s.startsWith("https://"));
}

function decodeBase64Safe(text) {
  const cleaned = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (cleaned.length % 4)) % 4;
  return Buffer.from(cleaned + "=".repeat(padLen), "base64").toString("utf8");
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

  return lines
    .map((line) => line.trim())
    .filter((line) => VALID_PROTO_REGEX.test(line));
}

function safeDecodeURI(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

// 提取去重指纹（同一台服务器即使在不同仓库被改了#备注名，也能自动去重）
function getNodeDedupKey(node) {
  if (node.toLowerCase().startsWith("vmess://") || node.toLowerCase().startsWith("ssr://")) {
    return node;
  }
  const hashIdx = node.indexOf("#");
  return hashIdx !== -1 ? node.slice(0, hashIdx) : node;
}

async function fetchSingleSource(url, label, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "v2rayN/6.45" },
    });
    if (!res.ok) {
      return { label, ok: false, status: res.status, nodes: [] };
    }
    const text = await res.text();
    const nodes = parseNodes(text);
    return { label, ok: true, count: nodes.length, nodes };
  } catch (err) {
    return { label, ok: false, error: err?.name || "fetch_error", nodes: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildAggregatedSub({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedSub.base64 && now < cachedSub.expireAt) {
    return { base64: cachedSub.base64, stats: { ...cachedSub.stats, fromCache: true } };
  }

  // 从 Vercel 环境变量读取（支持多链接逗号或换行分隔）
  const ownUrls = splitEnvUrls(process.env.OWN_SUB_URLS);
  const envPublicUrls = splitEnvUrls(process.env.PUBLIC_SUB_URLS);
  const publicUrls = Array.from(new Set([...DEFAULT_PUBLIC_SUB_URLS, ...envPublicUrls]));

  const tasks = [
    ...ownUrls.map((u, idx) => fetchSingleSource(u, `own_${idx + 1}`, 8000)),
    ...publicUrls.map((u, idx) => fetchSingleSource(u, `public_${idx + 1}`, 6500)),
  ];

  const results = await Promise.all(tasks);

  const uniqueMap = new Map();
  let filteredAds = 0;

  for (const res of results) {
    for (const node of res.nodes) {
      const remark = safeDecodeURI(node.split("#")[1] || "");
      // 过滤公开订阅里常见的无效广告/信息提示假节点
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

  const stats = {
    fromCache: false,
    updatedAt: new Date(now).toISOString(),
    totalUniqueNodes: finalNodes.length,
    filteredAdNodes: filteredAds,
    sources: results.map((r) => ({
      label: r.label,
      ok: r.ok,
      count: r.count || 0,
      ...(r.status ? { status: r.status } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
  };

  cachedSub = {
    base64,
    stats,
    expireAt: now + CACHE_TTL_MS,
  };

  return { base64, stats };
}
