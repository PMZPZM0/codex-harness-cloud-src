/**
 * 渲染层**源码指纹**（云助手专有）。
 *
 * 判据来源：守卫【288】要回答的是「渲染层改了有没有部署到服务器」。原先比的是
 * `dist/index.html` 的**产物**哈希，但产物哈希**不是构建起点无关的**（10-16 实测：
 * `clean-dist` 后首次构建与在旧产物上再构建得到不同哈希；而 `npm run check` 每次都先
 * clean 再 build ⇒ **任何一次 check 都会把已部署的产物判成"变了"** ⇒ 守卫恒红、纯噪声）。
 *
 * 改比源码指纹：`src/**` + `public/**` + `index.html` 的相对路径 + 内容（排序后逐条喂 hash）。
 * 只有**真的改了渲染层源码**才会变 —— 重建、换机器、复制目录都不影响（⛔ 也因此不用 mtime：
 * checkout / 打包 / 复制都会改 mtime，误报率极高）。
 *
 * ⛔ 与 `scripts/deploy-cloud-ui.mjs` 必须同一口径：两处都调本函数，不许各写一份。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "public"];
const EXTRA_FILES = ["index.html"];

export function rendererSourceHash(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  for (const rel of ROOTS) {
    const dir = path.join(root, rel);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) walk(dir);
  }
  for (const rel of EXTRA_FILES) {
    const file = path.join(root, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  // 排序保证与文件系统返回顺序无关（跨平台/跨机器一致）。
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
