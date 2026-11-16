// api/team-sub.mjs
import { buildAggregatedSub } from "../src/aggregator.mjs";

const ALIVE_RAW_URL =
  "https://raw.githubusercontent.com/fj343824402/cfnew-panel/alive-sub/alive.txt";

export default async function handler(req, res) {
  try {
    const host = req.headers.host || "localhost";
    const reqUrl = new URL(req.url || "/team-sub", `https://${host}`);

    // 1. 团队密钥鉴权
    const expectedToken = (process.env.TEAM_TOKEN || "").trim();
    const gotToken = (reqUrl.searchParams.get("token") || "").trim();
    if (expectedToken && gotToken !== expectedToken) {
      res.statusCode = 401;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Unauthorized: invalid token");
      return;
    }

    const mode = reqUrl.searchParams.get("mode") || "";
    const forceRefresh = reqUrl.searchParams.get("refresh") === "1";
    const isDebug = reqUrl.searchParams.get("debug") === "1";

    // 2. 精选活节点模式（转发 GitHub Actions 测活后的纯活节点，若还没生成则自动降级）
    if (mode === "alive" && !isDebug) {
      try {
        const r = await fetch(ALIVE_RAW_URL, { headers: { "User-Agent": "cfnew-panel" } });
        if (r.ok) {
          const aliveText = (await r.text()).trim();
          if (aliveText) {
            res.statusCode = 200;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.setHeader(
            "cache-control",
            forceRefresh ? "no-store" : "public, s-maxage=300, stale-while-revalidate=600"
          );
            res.end(aliveText);
            return;
          }
        }
      } catch {}
    }

    const { base64, stats } = await buildAggregatedSub({ forceRefresh });

    if (isDebug) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader(
      "cache-control",
      forceRefresh ? "no-store" : "public, s-maxage=300, stale-while-revalidate=600"
    );
    res.end(base64);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Aggregator error: " + (err?.message || "unknown"));
  }
}
