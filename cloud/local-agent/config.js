"use strict";
/**
 * Codex Harness Cloud · 本地伴生服务 —— 配置与状态
 *
 * ⛔ 设计前提（CLOUD-VERSION-PLAN 方案 A）：**本地是唯一真相源**。
 *   伴生服务只做两件事：把本机的能力（引擎、工作区、文件、shell）按一套窄协议暴露给
 *   浏览器端界面，以及把"界面资源从哪来"这件事保持可替换。
 *   所以这里**不存会话内容**，只存三样：监听端口、配对 token、云端资产地址。
 *
 * 落点：$HARNESS_CLOUD_HOME（默认 ~/.codex-harness-cloud/），与桌面版的 userData 完全分开
 *   —— 云版是独立产品，不碰桌面版的账号库/记忆/rollout，避免两个入口互相污染。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

/** 协议版本：浏览器端与伴生服务靠它协商。⛔ 只增不改 —— 改语义必须 +1 并同时发两端。 */
const PROTOCOL_VERSION = 1;

const DEFAULT_PORT = 8917;
/** 云端资产默认地址：发布站的 /cloud/ 路径（Caddy handle_path → /var/www/codex-harness-cloud）。 */
const DEFAULT_CDN_BASE = "https://ppz123.asia/cloud";
/**
 * 账号服务地址（**配对闸的开关**，10-13）。
 * ⛔ 语义：**非空 = 开闸** —— 任何配对都必须先有网页账号（票据）；本机据此**反向核销**。
 *   设成空串（`HARNESS_ACCOUNTS_URL=""` 或 config.json 里 `accountsBase: ""`）= **独立模式**：
 *   退回"只有本机配对码"的旧行为，供自建/离线部署；启动横幅会**大声说明**当前是哪种模式。
 */
const DEFAULT_ACCOUNTS_BASE = "https://ppz123.asia/cloud-api";

function homeDir() {
  return process.env.HARNESS_CLOUD_HOME || path.join(os.homedir(), ".codex-harness-cloud");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 读 JSON，坏文件不抛（宁可回到默认值也不要让伴生服务起不来）。 */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写：先写 tmp 再 rename —— 写一半被杀只留旧文件，不会留半截 JSON。 */
function writeFileAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/**
 * 解析引擎二进制。顺序：显式配置 → 环境变量 → 仓库 ./node_modules → 脚本同级。
 * ⛔ 不写死绝对路径：云版要能装在别的机器上，二进制位置随安装方式而变。
 */
function resolveEngineBinary(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.HARNESS_CODEX_BINARY && fs.existsSync(process.env.HARNESS_CODEX_BINARY)) {
    return process.env.HARNESS_CODEX_BINARY;
  }
  const key = `${process.platform}-${process.arch}`;
  const packages = {
    "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
    "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
    "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
    "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
    "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
    "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  };
  const target = packages[key];
  if (!target) return null;
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  // 候选根：进程 cwd、本文件上溯三层（cloud/local-agent → cloud → 仓库根）
  const roots = [
    process.cwd(),
    path.resolve(__dirname, "..", ".."),
    path.resolve(__dirname, ".."),
  ];
  for (const root of roots) {
    const candidate = path.join(root, "node_modules", target[0], "vendor", target[1], "bin", executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function load() {
  const home = ensurePrivateDir(homeDir());
  const file = path.join(home, "config.json");
  const saved = readJsonSafe(file) || {};

  const config = {
    home,
    configFile: file,
    port: Number(process.env.HARNESS_CLOUD_PORT || saved.port || DEFAULT_PORT),
    /** 界面资源地址。改这一行 + 重新部署资产 = 换界面，**不需要重装伴生服务**。 */
    cdnBase: String(process.env.HARNESS_CLOUD_CDN || saved.cdnBase || DEFAULT_CDN_BASE).replace(/\/+$/, ""),
    /**
     * 账号服务地址；**非空 = 配对必须先有账号**（见文件头 DEFAULT_ACCOUNTS_BASE 的语义说明）。
     * ⛔ 空串是**显式选择**（`??` 而不是 `||`）：`""` 必须能压住默认值，否则独立模式根本设不出来。
     */
    accountsBase: String(process.env.HARNESS_ACCOUNTS_URL ?? saved.accountsBase ?? DEFAULT_ACCOUNTS_BASE).replace(/\/+$/, ""),
    /** 允许直连的浏览器来源（桌面浏览器 + 手机浏览器 + 云端页面）。缺省只放本机。 */
    allowedOrigins: Array.isArray(saved.allowedOrigins) && saved.allowedOrigins.length
      ? saved.allowedOrigins
      : [`http://127.0.0.1:${Number(process.env.HARNESS_CLOUD_PORT || saved.port || DEFAULT_PORT)}`,
         `http://localhost:${Number(process.env.HARNESS_CLOUD_PORT || saved.port || DEFAULT_PORT)}`],
    engine: {
      binary: resolveEngineBinary(saved.engine && saved.engine.binary),
      codexHome: String(process.env.CODEX_HOME || (saved.engine && saved.engine.codexHome) || path.join(os.homedir(), ".codex")),
      cwd: String((saved.engine && saved.engine.cwd) || process.cwd()),
    },
    logFile: path.join(home, "local-agent.log"),
    protocolVersion: PROTOCOL_VERSION,
  };

  // token 首次运行生成，落盘 0600。⛔ 不进日志、不进 handshake 响应。
  const tokenFile = path.join(home, "token");
  let token = "";
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch { /* 首次运行 */ }
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    writeFileAtomic(tokenFile, token, 0o600);
  }
  config.token = token;
  config.tokenFile = tokenFile;

  // 把可持久化字段写回（端口/CDN/账号服务被 CLI 或环境变量改写后要记住）
  const persist = {
    port: config.port,
    cdnBase: config.cdnBase,
    accountsBase: config.accountsBase,
    engine: { binary: config.engine.binary, codexHome: config.engine.codexHome },
  };
  if (JSON.stringify(saved.port) !== JSON.stringify(persist.port)
    || saved.cdnBase !== persist.cdnBase
    || (saved.accountsBase ?? DEFAULT_ACCOUNTS_BASE) !== persist.accountsBase) {
    try { writeFileAtomic(file, `${JSON.stringify(persist, null, 2)}\n`, 0o600); } catch { /* 只读盘就算了 */ }
  }
  return config;
}

module.exports = { load, homeDir, resolveEngineBinary, PROTOCOL_VERSION, DEFAULT_PORT, DEFAULT_CDN_BASE, DEFAULT_ACCOUNTS_BASE };
