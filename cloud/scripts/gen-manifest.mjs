#!/usr/bin/env node
/**
 * 生成发版清单 `cloud/manifest.json` 的 sha256（**发版必跑**）。
 *
 * 为什么需要 hash：
 *   ⛔ 镜像 raw 有 CDN 缓存，会**静默返回旧版内容**（2026-10-18 实测：更新把生产覆盖成旧代码）。
 *   ⇒ 清单里带上每个文件的 sha256；下载端逐个校验，**不匹配就换下一个镜像**，
 *      所有镜像都不匹配才中止。这样"缓存旧版"永远不可能被装上。
 *
 * 用法：
 *   node cloud/scripts/gen-manifest.mjs                 # 按现有 version 重算 hash
 *   node cloud/scripts/gen-manifest.mjs --version 1.1.1 # 同时改版本号
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");                 // 仓根
const manifestPath = path.join(root, "cloud", "manifest.json");

if (!existsSync(manifestPath)) {
  console.error("找不到 cloud/manifest.json");
  process.exit(1);
}
const m = JSON.parse(readFileSync(manifestPath, "utf8"));

const vArg = process.argv.indexOf("--version");
if (vArg > -1 && process.argv[vArg + 1]) {
  m.version = String(process.argv[vArg + 1]).trim();
  // VERSION 文件与清单保持一致（服务端读它做当前版本）
  writeFileSync(path.join(root, "cloud", "VERSION"), m.version + "\n");
}

if (!Array.isArray(m.files) || !m.files.length) {
  console.error("manifest.files 为空");
  process.exit(1);
}

let bad = 0;
for (const f of m.files) {
  const abs = path.join(root, f.src);
  if (!existsSync(abs)) {
    console.error(`  ✗ ${f.src} 不存在`);
    bad++;
    continue;
  }
  /* ⛔⛔ Windows 工作区是 **CRLF**，而 GitHub 的 blob 与 raw 下载内容都是 **LF**。
     不归一就永远 hash 不匹配（下载端会判定"缓存旧版"并拒绝所有源）。 */
  const raw = readFileSync(abs);
  /* ⛔⛔ 二进制绝不能做 LF 归一：toString("utf8") 会把非法字节替换成 U+FFFD，
     再 Buffer.from 就得到另一个文件（实测 PNG 5280B → 9397B，hash 全错）。 */
  const isBin = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|mp3|mp4)$/i.test(f.src);
  const buf = isBin ? raw : Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  f.sha256 = createHash("sha256").update(buf).digest("hex");
  f.bytes = buf.length;
  const crlf = isBin ? "（二进制，按原始字节）" : (raw.includes("\r\n") ? "（已按 LF 归一）" : "");
  console.log(`  ✓ ${f.src.padEnd(44)} ${f.sha256.slice(0, 12)}… ${buf.length} B${crlf}`);
}
if (bad) {
  console.error(`有 ${bad} 个文件缺失，未写入 manifest`);
  process.exit(1);
}

m.releasedAt = new Date().toISOString().slice(0, 10);
writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
console.log(`\n已写入 cloud/manifest.json：version=${m.version}，${m.files.length} 个文件，releasedAt=${m.releasedAt}`);
