// api/team-sub.mjs
import { buildAggregatedSub } from "../src/aggregator.mjs";

export default async function handler(req, res) {
  try {
    const host = req.headers.host || "localhost";
    const reqUrl = new URL(req.url || "/team-sub", `https://${host}`);

    // 1. 团队密钥鉴权（在 Vercel 环境变量里设置 TEAM_TOKEN）
    const expectedToken = (process.env.TEAM_TOKEN || "").trim();
    const gotToken = (reqUrl.searchParams.get("token") || "").trim();
    if (expectedToken && gotToken !== expectedToken) {
      res.statusCode = 401;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Unauthorized: invalid token");
      return;
    }

    const forceRefresh = reqUrl.searchParams.get("refresh") === "1";
    const isDebug = reqUrl.searchParams.get("debug") === "1";

    const { base64, stats } = await buildAggregatedSub({ forceRefresh });

    // ?debug=1 方便你在浏览器里直观检查每个公开源抓了多少节点
    if (isDebug) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    // 允许客户端及边缘短暂缓存 5 分钟
    res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=60");
    res.end(base64);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Aggregator error: " + (err?.message || "unknown"));
  }
}
