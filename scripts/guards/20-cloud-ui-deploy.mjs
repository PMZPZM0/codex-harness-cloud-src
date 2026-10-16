/**
 * 预检守卫组：20-cloud-ui-deploy（**云助手专有**，⛔ 不同步到桌面版 / PPcode）
 * 【288】渲染层改动**必须已部署到服务器**，否则强制报红。
 *
 * 背景（⛔ 别再犯）：云助手是「本地壳 + 云端界面」——
 *   `electron/headless.ts` 在云端模式下把整份 index.html 与**全部资产**指向
 *   `https://ppz123.asia/cloud/app/`（常量 CLOUD_APP_BASE，源码注释即「服务器上有，本地就是一个壳」）；
 *   本地 `dist/` 只在 version.json 不可达或 protocolVersion 不匹配时兜底，**正常运行时永远不走**。
 * ⇒ 只在本机 `npm run build` 而没跑 `scripts/deploy-cloud-ui.mjs`
 *    = 用户看到的仍是服务器上的旧界面（症状："改了没生效 / 老是不刷新 / 又是旧的"）。
 *   10-16 实证：服务器仍引用 index-BVVBGlrK.js（10-15 构建），本地新产物是 index-qhyaKyqe.js。
 *
 * 判据（离线、确定性，不联网）：
 *   本地 `dist/index.html` 的主入口资产指纹 == `.cloud-ui-deployed.json` 里记的那份
 *   （后者由部署脚本在**实测校验通过后**写入）。不等 ⇒ 红。
 * ⛔ 不用 mtime：checkout / 打包 / 复制都会改 mtime，误报率极高；资产哈希是内容指纹。
 * ⛔ 覆盖链：src 改 ⇒ 既有守卫报「渲染层产物已过期」（逼 build）⇒ build 后哈希变
 *    ⇒ 本守卫报红（逼部署）⇒ 部署脚本写记录 ⇒ 转绿。
 */
import { C, ROOT, existsSync, fail, join, ok, readFileSync } from "./_ctx.mjs";

/** dist/index.html 的主入口资产指纹（排序后拼接，顺序无关）。 */
function hashesOf(html) {
  return (html.match(/assets\/index-[A-Za-z0-9]*\.(?:js|css)/g) || []).sort().join(",");
}

export async function run() {
  console.log(C.bold("\n【288】云端界面已部署（云助手专有）"));

  const distIndex = join(ROOT, "dist", "index.html");
  if (!existsSync(distIndex)) {
    /* 没 build ⇒ 无从判断（既有守卫会先报"产物过期"），这里不重复红。 */
    console.log("  (跳过【288】：dist/index.html 不存在 —— 先 npm run build)");
    return;
  }
  const local = hashesOf(readFileSync(distIndex, "utf8"));
  let state = null;
  try { state = JSON.parse(readFileSync(join(ROOT, ".cloud-ui-deployed.json"), "utf8")); } catch { state = null; }
  const deployed = state?.assetHashes ?? "";
  (local !== "" && local === deployed ? ok : fail)(
    `【288】本地渲染层产物已部署到服务器（未部署 ⇒ 用户永远看不到；本地=${local || "(空)"}，已部署=${deployed || "从未部署"}；修：node scripts/deploy-cloud-ui.mjs）`
  );
}
