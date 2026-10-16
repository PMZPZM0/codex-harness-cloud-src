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
 * 判据（离线、确定性，不联网）= **渲染层源码指纹**：
 *   本地 `src/**` + `public/**` + `index.html` 的 sha256 == `.cloud-ui-deployed.json` 里记的那份
 *   （后者由部署脚本在**实测校验通过后**写入）。不等 ⇒ 红。
 * ⛔ 为什么不用 dist 的**产物**哈希（10-16 换掉）：产物哈希**不是构建起点无关的** ——
 *   实测 `clean-dist` 后首次构建得到 `index-Df6B4kFT.js`，在旧产物上再构建得到
 *   `index-B7BkQJSc.js`；而 `npm run check` 每次都先 clean 再 build ⇒ **任何一次 check 都会把
 *   已部署的产物判成"变了"** ⇒ 守卫恒红、纯噪声（用户最烦的就是乱翻的判据）。
 *   源码指纹只随**真的改了渲染层源码**变化：重建、换机器、复制目录都不影响。
 *   ⛔ 也不用 mtime：checkout / 打包 / 复制都会改 mtime，误报率极高。
 * ⛔ 覆盖链：src 改 ⇒ 既有守卫报「渲染层产物已过期」（逼 build）⇒ build 后源码指纹**不变**
 *   ⇒ 本守卫仍报红（逼部署）⇒ 部署脚本写记录 ⇒ 转绿。
 * ⛔ 指纹算法与部署脚本同源：两边都调 `scripts/lib/renderer-source-hash.mjs`，不许各写一份。
 */
import { C, ROOT, fail, join, ok, readFileSync } from "./_ctx.mjs";
import { rendererSourceHash } from "../lib/renderer-source-hash.mjs";

export async function run() {
  console.log(C.bold("\n【288】云端界面已部署（云助手专有）"));

  const local = rendererSourceHash(ROOT);
  let state = null;
  try { state = JSON.parse(readFileSync(join(ROOT, ".cloud-ui-deployed.json"), "utf8")); } catch { state = null; }
  const deployed = typeof state?.sourceHash === "string" ? state.sourceHash : "";
  if (!deployed) {
    fail("【288】部署记录里没有 sourceHash（旧格式记录）—— 请重新跑一次 node scripts/deploy-cloud-ui.mjs");
    return;
  }
  (local === deployed ? ok : fail)(
    `【288】当前渲染层源码已部署到服务器（未部署 ⇒ 用户永远看不到最新界面；本地=${local.slice(0, 12)}…，已部署=${deployed.slice(0, 12)}…；修：node scripts/deploy-cloud-ui.mjs）`
  );
}
