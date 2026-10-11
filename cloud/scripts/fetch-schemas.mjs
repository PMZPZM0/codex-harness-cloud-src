/**
 * Codex Harness Cloud · 生成协议 schema 参照物
 *
 *   node scripts/fetch-schemas.mjs            # 缺才生成（幂等）
 *   node scripts/fetch-schemas.mjs --force    # 强制重生成（引擎升级后：schema 会变）
 *
 * 为什么要它：自测要用**独立参照物**校验我们发给引擎的回包形状。参照物必须来自
 * "引擎自己"（`codex app-server generate-json-schema`），不能来自我们自己写的常量
 * —— 那样就成了"自己给自己出题自己判卷"（本仓 10-05 的记忆白屏事故就是这么发生的：
 * 契约两边出自同一份想象，56/56 全绿但功能是坏的）。
 *
 * 产物落 cloud/.schema/（生成物，已 gitignore）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.resolve(HERE, "..");
const OUT_DIR = path.join(CLOUD_DIR, ".schema");
const FORCE = process.argv.includes("--force");

function candidateBinaries() {
  const list = [];
  if (process.env.HARNESS_CODEX_BINARY) list.push(process.env.HARNESS_CODEX_BINARY);
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const targets = {
    "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
    "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
    "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
    "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
    "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
    "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) return list;
  // 副本自己的 node_modules → 桌面版工作副本（只读借用，不改它）
  const roots = [
    CLOUD_DIR,
    path.resolve(CLOUD_DIR, "..", ".."),
    "D:/Codex Harness Desktop",
    "/d/Codex Harness Desktop",
  ];
  for (const root of roots) {
    const candidate = path.join(root, "node_modules", target[0], "vendor", target[1], "bin", exe);
    if (existsSync(candidate)) list.push(candidate);
  }
  return list;
}

function existingCount() {
  try {
    return readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

if (!FORCE && existingCount() >= 20) {
  console.log(`[schema] 已存在 ${existingCount()} 个文件，跳过（--force 可强制重生成）`);
  process.exit(0);
}

const binary = candidateBinaries().find((candidate) => existsSync(candidate));
if (!binary) {
  console.error("[schema] 找不到 codex 引擎二进制。请设置 HARNESS_CODEX_BINARY 指向它，");
  console.error("         或在 cloud/ 下 npm install（云版的 schema 参照物由引擎自产，不手抄）。");
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(`[schema] 用引擎生成：${binary}`);
// ⛔ 用异步 spawn，不用 spawnSync：spawnSync 在本项目的沙箱环境里会被拦（exit=null 且无输出），
//   而异步 spawn 正常；顺手也避免长时间阻塞事件循环。
const outcome = await new Promise((resolve) => {
  const child = spawn(binary, ["app-server", "generate-json-schema", "--out", OUT_DIR], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", (error) => resolve({ code: -1, message: error.message }));
  child.on("exit", (code) => resolve({ code, message: stderr.trim().slice(0, 400) }));
});
if (outcome.code !== 0) {
  console.error(`[schema] 生成失败（exit=${outcome.code}）：${outcome.message}`);
  rmSync(OUT_DIR, { recursive: true, force: true });
  process.exit(1);
}
const count = existingCount();
if (count < 20) {
  console.error(`[schema] 生成结果可疑：只有 ${count} 个文件`);
  process.exit(1);
}
console.log(`[schema] 完成：${count} 个 schema 文件 → ${path.relative(CLOUD_DIR, OUT_DIR)}`);
