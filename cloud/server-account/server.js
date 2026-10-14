"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   Codex Harness Cloud · 账号服务（跑在站长的服务器上，不随桌面助手分发）

   职责：账号密码注册/登录、会话、管理员用户管理。**只存身份，不存任何用户内容**
   （会话/文件/凭据仍全在各用户本机）—— 服务器被拖库最多泄露账号表。

   安全设计（用户明确不要验证码 ⇒ 用限速 + 锁定 + 常量时间比较替代）：
   · 密码 scrypt + 每用户独立盐；校验全程 timingSafeEqual
   · 注册：每 IP 每小时 3 次；用户名 3~24 位 [A-Za-z0-9_-]；密码 ≥8 位
   · 登录：每 IP 10 次/5 分钟；单账号连错 5 次锁 15 分钟
   · 会话：随机 32B token，服务端只存 sha256，7 天过期，登出即吊销
   · 管理员：--init-admin 签发（首建即 admin），可禁用/启用/重置/删除用户
   · 绑定 127.0.0.1，只经 Caddy 反代对外；CORS 只放行站点自身 Origin
   ══════════════════════════════════════════════════════════════════════════ */
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.HARNESS_ACCOUNTS_PORT || 8091);
const DATA_FILE = process.env.HARNESS_ACCOUNTS_FILE || path.join(__dirname, "data.json");
/* ── 配额（单一真相源；界面文案从 /sync/usage 与 /device/list 读，别在前端再写一份） ── */
const DEVICE_LIMIT = Number(process.env.HARNESS_DEVICE_LIMIT || 3);                       // 每账号最多绑定机器数
const STORAGE_LIMIT_BYTES = Number(process.env.HARNESS_STORAGE_LIMIT || 1024 * 1024 * 1024); // 每账号 1 GB
/** 云端数据落盘根：与账号文件同目录，便于一起备份/迁移。 */
const SYNC_DIR = process.env.HARNESS_SYNC_DIR || path.join(path.dirname(DATA_FILE), "sync");
/* ── 内置供应商「限时福利」：模型目录来自 WBM（WorkBuddy Manager） ──────────────
   ⛔⛔ 安全加固（10-14 用户令）：地址与密钥**一律不硬编码、不入日志、不下发前端**。
   · 取值顺序：systemd 凭据目录（$CREDENTIALS_DIRECTORY/<name>，宿主机密钥加密）
     → 环境变量（本地开发用）→ 空（如实报"未配置"，**不猜地址**）
   · 启动/日志里只出现"是否已配置"，任何出错信息都要过 sanitize() 脱敏。 */
function readSecret(name, envName) {
  const dir = process.env.CREDENTIALS_DIRECTORY || "";
  if (dir) {
    try {
      const v = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (v) return v;
    } catch { /* 凭据不存在就走环境变量 */ }
  }
  return String(process.env[envName] || "").trim();
}
/** 日志脱敏：把任何形如 wbt_/wbk_ 的凭据换成前缀+掩码（前缀留 8 位便于排障）。 */
function sanitize(text) {
  return String(text == null ? "" : text).replace(/(wbt_|wbk_)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, "$1$2…[已脱敏]");
}
const WBM_BASE = String(process.env.WBM_BASE || "").trim().replace(/\/+$/, "");
const WBM_TOKEN = readSecret("wbm-token", "WBM_TOKEN");
const WBM_GATEWAY_KEY = readSecret("wbm-gateway-key", "WBM_GATEWAY_KEY");
/** 客户端要用的"供应商地址"= 本服务同源代理路径（⛔ 不下发上游真实地址）。 */
const BUILTIN_PROXY_PATH = "/cloud-api/proxy/v1";
/** 模型目录缓存时长（WBM 自己也有 5 分钟缓存；这里更宽，避免频繁拉） */
const MODEL_SYNC_TTL_MS = 30 * 60_000;
/** 内置供应商在客户端的稳定 id 与展示名 */
const BUILTIN_PROVIDER_ID = "limited-benefit";
const BUILTIN_PROVIDER_NAME = "限时福利";
const ALLOWED_ORIGINS = (process.env.HARNESS_ACCOUNTS_ORIGINS || "https://ppz123.asia,https://www.ppz123.asia").split(",");
const SESSION_TTL_MS = 7 * 24 * 3600_000;

/* ── 存储（原子写 + 600 权限）────────────────────────────────────────────── */
let db = { users: [], sessions: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* 首次运行 */ }
if (!Array.isArray(db.users)) db.users = [];
if (typeof db.sessions !== "object" || !db.sessions) db.sessions = {};
function persist() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

/* ── 密码与会话 ──────────────────────────────────────────────────────────── */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}
function makeUser(username, password, role) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { username, role: role || "user", salt, hash: hashPassword(password, salt), createdAt: Date.now(), disabled: false, failCount: 0, lockUntil: 0, lastLogin: 0 };
}
function verifyPassword(user, password) {
  const actual = Buffer.from(user.hash, "hex");
  const presented = Buffer.from(hashPassword(password, user.salt), "hex");
  return actual.length === presented.length && crypto.timingSafeEqual(actual, presented);
}
function issueSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[crypto.createHash("sha256").update(token).digest("hex")] = { username, exp: Date.now() + SESSION_TTL_MS };
  // 顺手清过期会话
  const now = Date.now();
  for (const [hash, session] of Object.entries(db.sessions)) if (session.exp < now) delete db.sessions[hash];
  persist();
  return token;
}
function sessionUser(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const session = db.sessions[crypto.createHash("sha256").update(token).digest("hex")];
  if (!session || session.exp < Date.now()) return null;
  const user = db.users.find((u) => u.username === session.username);
  return user && !user.disabled ? user : null;
}

/* ── 配对票据（10-13：把「账号」变成配对的前置条件）─────────────────────────
   背景与边界：账号服务原本只管"网站身份"，与各用户本机的配对链路**毫无连接** ——
   于是"先在网页注册"只是网页自己的门，从本机侧可以完全绕开（本机 URL + 控制台自动链接）。
   现在补一层**票据**：网页用账号会话换一张一次性票据 → 用户本机拿它来核销 → 本机凭回执决定放行。

   ⛔ 为什么必须是"本机反向核销"而不是"网页转述"：网页代码完全在用户手里
      （改 localStorage、直接 curl 本机 127.0.0.1 的接口都行），它说的"我登录了"一文不值。
      唯一可信的是**账号服务自己给的回执**。

   · 票据 32B 随机、**一次性**、TTL 120 秒、绑定 username；服务端只存 sha256；
   · 核销即作废（usedAt）⇒ 重放返回 `used`；
   · 核销时**重新校验账号状态** ⇒ 被停用的账号连新配对都拿不到；
   · ⛔ 不做服务间共享密钥：**票据本身就是凭证**（32B 随机 + 一次性 + 限速），
     与它替代的配对码同一信任模型；将来若要更强的机机互信，在这里加 `x-harness-service` 即可。
   ⛔ 票据绝不写日志（与 token / 配对码 同口径）。 */
const TICKET_TTL_MS = 120_000;
if (typeof db.tickets !== "object" || !db.tickets) db.tickets = {};
function pruneTickets() {
  const now = Date.now();
  for (const [hash, entry] of Object.entries(db.tickets)) if (entry.exp < now) delete db.tickets[hash];
}
function issueTicket(username) {
  pruneTickets();
  const ticket = crypto.randomBytes(32).toString("hex");
  const exp = Date.now() + TICKET_TTL_MS;
  db.tickets[crypto.createHash("sha256").update(ticket).digest("hex")] = { username, exp, usedAt: 0 };
  persist();
  return { ticket, exp };
}
/** 核销：成功即作废。失败原因**分档**（本机侧要据此区分"码错"与"账号问题"，不能混成一句话）。 */
function verifyTicket(ticket) {
  pruneTickets();
  const raw = String(ticket || "").trim();
  if (!raw) return { ok: false, reason: "unknown" };
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const found = db.tickets[hash];
  if (!found) return { ok: false, reason: "unknown" };
  if (found.usedAt) return { ok: false, reason: "used" };
  if (found.exp < Date.now()) { delete db.tickets[hash]; persist(); return { ok: false, reason: "expired" }; }
  const user = db.users.find((u) => u.username === found.username);
  if (!user || user.disabled) return { ok: false, reason: "account-disabled" };
  found.usedAt = Date.now();
  persist();
  return { ok: true, username: found.username };
}

/* ── 设备绑定（10-13 二期）：本机码 → 云端匹配 → 下发设备 token ─────────────
   流程（方案 A+ 的第一块地基 —— 账号开始有实际价值）：
     ① 本机生成配对码并显示（本机负责生成，这一步永远离线）；
     ② 用户在网页注册/登录后提交这个码（认领）；
     ③ 服务端把「账号 ⟷ 本机码」绑定并生成**设备 token**（32B 随机，只存 sha256）；
     ④ 本机轮询拿走 token → 存本机 ⇒ 允许连接服务器（拉更新 / 将来的云功能）。

   ⛔ 信任模型与配对码一致：**码即凭据**（8 位十六进制 + 认领需网页会话）。
   ⛔ 同码重复认领 = 重装/换机场景 ⇒ 重新生成 token（旧 token 立即失效）。
   ⛔ token 绝不写日志；服务端只存 sha256。 */
if (typeof db.devices !== "object" || !db.devices) db.devices = {};   // codeHash → 设备记录
/* 模型目录缓存：{ syncedAt, realm, source, list: [...] } —— 由 WBM 同步而来 */
if (typeof db.modelCatalog !== "object" || !db.modelCatalog) db.modelCatalog = { syncedAt: 0, realm: "cn", source: "", list: [] };
/* 每用户生效模型：username → [modelId]（空/缺省 = 全不启用，由用户勾选决定） */
if (typeof db.userModels !== "object" || !db.userModels) db.userModels = {};
/* 每用户代理令牌：username → { hash, prefix, createdAt, lastUsedAt, ips: [] }
   ⛔ 库内**只存 sha256**，明文仅签发时返回一次（与 WBM 的 api_tokens 同一形态）；
   ⛔ 它不是上游网关密钥 —— 上游密钥只在服务端由代理注入，客户端永远拿不到。 */
if (typeof db.proxyTokens !== "object" || !db.proxyTokens) db.proxyTokens = {};
const PROXY_TOKEN_PREFIX = "wap_";
const PROXY_IP_LIMIT = 5;                       // 同一令牌最多记住几个来源 IP（超出则拒）
function hashProxyToken(t) { return crypto.createHash("sha256").update(String(t || "")).digest("hex"); }
function proxyUserByToken(t) {
  const h = hashProxyToken(t);
  for (const [username, row] of Object.entries(db.proxyTokens)) {
    if (row && row.hash === h) return { username, row };
  }
  return null;
}
const DEVICE_CODE_RE = /^[0-9a-f]{8}$/;
/** 服务端密钥（HMAC 派生设备 token 用）：首次运行自动生成并落盘（0600）。
 *  ⛔ 为什么用派生而不是随机+存库：本机要靠**轮询**拿 token，而库里只存 sha256
 *     （拖库不泄露凭据）⇒ token 必须**可由服务端重算**。HMAC(serverSecret, code) 兼顾两者：
 *     库泄露拿不到 token；换 secret = 全部设备 token 同时失效（等于全员重配对，语义也正确）。 */
function serverSecret() {
  const secretFile = path.join(path.dirname(DATA_FILE), "secret.key");
  try { return fs.readFileSync(secretFile, "utf8").trim(); } catch { /* 首次运行 */ }
  const secret = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(secretFile, secret, { mode: 0o600 }); } catch (error) { console.error("[accounts] 密钥落盘失败：", error.message); }
  return secret;
}
/** 设备 token 派生基准：`mid:<机器标识>`（机器稳定、重配对不变）或 `code:<配对码>`（兼容旧记录）。
 *  ⛔ 仍然只存 sha256(token)：库泄露同样拿不到 token（基准不落库，只由记录里的 machineId/code 现算）。 */
function deviceTokenBaseOf(device) {
  const mid = String(device && device.machineId || "").trim();
  return mid ? "mid:" + mid : "code:" + String(device && device.code || "").trim().toLowerCase();
}
function deviceTokenOf(base) {
  return crypto.createHmac("sha256", serverSecret()).update(`device:${String(base || "").trim().toLowerCase()}`).digest("hex");
}
function deviceCodeHash(code) { return crypto.createHash("sha256").update(String(code || "").trim().toLowerCase()).digest("hex"); }
function deviceIdOf(codeHash) { return codeHash.slice(0, 8); }
/* ── 云端同步存储（P0：会话上传 + 索引；按账号分目录落盘） ─────────────────
   布局：<SYNC_DIR>/<username>/sessions/<sessionId>.jsonl  +  <SYNC_DIR>/<username>/index.json
   ⛔ 与本地 rollout 同构（逐行可比）；索引只存元数据（标题/项目/机器/时间/字节数/行数）。 */
function syncUserDir(username) { return path.join(SYNC_DIR, String(username || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_")); }
function syncIndexFile(username) { return path.join(syncUserDir(username), "index.json"); }
function readSyncIndex(username) {
  try { const raw = JSON.parse(fs.readFileSync(syncIndexFile(username), "utf8")); return raw && typeof raw === "object" ? raw : {}; }
  catch { return {}; }
}
function writeSyncIndex(username, index) {
  const dir = syncUserDir(username);
  try { fs.mkdirSync(path.join(dir, "sessions"), { recursive: true }); fs.writeFileSync(syncIndexFile(username), JSON.stringify(index)); return true; }
  catch (error) { console.error("[sync] 索引写入失败：", error.message); return false; }
}
/** 已用字节（索引累加，避免每次扫盘）。 */
function syncUsageBytes(username) {
  const index = readSyncIndex(username);
  let total = 0;
  for (const row of Object.values(index)) total += Number(row && row.sizeBytes || 0);
  return total;
}
function listDevices(username) {
  const out = [];
  for (const [hash, device] of Object.entries(db.devices)) {
    if (device.username !== username) continue;
    out.push({ id: deviceIdOf(hash), name: device.name, claimedAt: device.claimedAt, lastSeen: device.lastSeen || 0 });
  }
  return out.sort((a, b) => b.claimedAt - a.claimedAt);
}
/** 认领：码 + 网页会话 ⇒ 绑定账号。token 由服务端密钥派生（见 serverSecret 头注）。
 *  同码重复认领 = 重装/换机 ⇒ 绑定刷新（token 不变，因为它只由码派生）。 */
function claimDevice(code, username, name, machineId) {
  const raw = String(code || "").trim().toLowerCase();
  if (!DEVICE_CODE_RE.test(raw)) return { ok: false, reason: "bad-code" };
  const hash = deviceCodeHash(raw);
  /* ⛔ 每账号最多 DEVICE_LIMIT 台（10-14 用户令）。判重按 machineId：同一台机器重新配对不算新增
     （认领时会替换同机旧记录），所以先算出"去掉本机后还剩几台"。 */
  const mid0 = String(machineId || "").trim().slice(0, 64);
  const others = Object.values(db.devices).filter((d) => d.username === username && (!mid0 || d.machineId !== mid0)).length;
  if (others >= DEVICE_LIMIT) return { ok: false, reason: "device-limit", limit: DEVICE_LIMIT, current: others };
  /* ⛔ 一台机器恒一条记录（10-14 用户实测：面板里堆了 6 条"我的电脑"）：认领带本机稳定标识
     （installation_id）⇒ 先把**同一台机器**的旧记录删掉再写新的 = 重配对即更新。 */
  const mid = String(machineId || "").trim().slice(0, 64);
  if (mid) {
    for (const [oldHash, device] of Object.entries(db.devices)) {
      if (oldHash !== hash && device.machineId === mid) { delete db.devices[oldHash]; delete db.deviceCodes?.[oldHash]; }
    }
  }
  const prev = db.devices[hash];
  db.devices[hash] = {
    username,
    name: String(name || "").trim().slice(0, 32) || `设备-${deviceIdOf(hash)}`,
    code: raw,
    machineId: mid || prev?.machineId || "",
    tokenHash: crypto.createHash("sha256").update(deviceTokenOf(mid ? "mid:" + mid : "code:" + raw)).digest("hex"),
    claimedAt: prev?.claimedAt || Date.now(),
    lastSeen: prev?.lastSeen || 0,
  };
  persist();
  return { ok: true, device: { id: deviceIdOf(hash), name: db.devices[hash].name, token: deviceTokenOf(raw), rebound: Boolean(prev) } };
}
/** 入网核销：本机拿码换设备 token（轮询用；码即凭据）。⛔ 账号被停用 ⇒ 拒绝。 */
function redeemDeviceCode(code) {
  const raw = String(code || "").trim().toLowerCase();
  if (!DEVICE_CODE_RE.test(raw)) return { ok: false, claimed: false, reason: "unknown" };
  const device = db.devices[deviceCodeHash(raw)];
  if (!device) return { ok: false, claimed: false };
  const user = db.users.find((u) => u.username === device.username);
  if (!user || user.disabled) return { ok: false, claimed: true, reason: "account-disabled" };
  device.lastSeen = Date.now();
  persist();
  return { ok: true, claimed: true, username: device.username, name: device.name, id: deviceIdOf(deviceCodeHash(raw)), token: deviceTokenOf(deviceTokenBaseOf(device)) };
}
/** 凭设备 token 找设备（tokenHash 反查；db.devices 的键是 code+token 的组合哈希）。 */
function findDeviceByToken(token) {
  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  for (const device of Object.values(db.devices)) if (device.tokenHash === hash) return device;
  return null;
}
/** 更新通道元数据（服务器管理员维护的 updates.json；没有就视为已最新）。 */
function readUpdateMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(DATA_FILE), "updates.json"), "utf8"));
    return {
      available: Boolean(raw.available),
      latest: String(raw.latest || ""),
      url: String(raw.url || ""),
      notes: String(raw.notes || ""),
    };
  } catch { return { available: false, latest: "", url: "", notes: "" }; }
}
/** 吊销：删除设备（token 随之失效）。 */
function revokeDevice(username, id) {
  for (const [hash, device] of Object.entries(db.devices)) {
    if (device.username === username && deviceIdOf(hash) === String(id || "")) {
      delete db.devices[hash];
      persist();
      return true;
    }
  }
  return false;
}

/* ── 限速 ────────────────────────────────────────────────────────────────── */
const buckets = new Map();   // key → { count, resetAt }
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  bucket.count += 1;
  return bucket.count <= max;
}
function ipOf(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

/* ── 路由 ────────────────────────────────────────────────────────────────── */
function usernameOk(name) { return /^[A-Za-z0-9_-]{3,24}$/.test(String(name || "")); }
function passwordOk(pw) { return typeof pw === "string" && pw.length >= 8 && pw.length <= 128; }
function publicView(user) {
  return { username: user.username, role: user.role, createdAt: user.createdAt, disabled: user.disabled, lastLogin: user.lastLogin || 0 };
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  // ⛔ 服务端硬闸：带 Origin 的请求必须来自站点自身。只回空 CORS 头是不够的 ——
  //   那只靠浏览器拦截，curl/脚本直连就绕过了（真实测试里 evil origin 注册成功过）。
  //   无 Origin = 非浏览器发起，放行（服务本机自检用）。
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "origin-not-allowed" }));
    return;
  }
  const cors = ALLOWED_ORIGINS.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600", Vary: "Origin" } : {};
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cors }); res.end(JSON.stringify(body)); };
  const readBody = () => new Promise((resolve, reject) => {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 64 * 1024) { reject(new Error("too-large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error("bad-json")); } });
    req.on("error", reject);
  });
  /** 大 body 读取（同步上传用）：默认 readBody 限 64KB，会话批次远超 —— 单次上限 32MB。 */
  const readBodyLarge = (limit = 32 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too-large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { const raw = Buffer.concat(chunks).toString("utf8"); resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error("bad-json")); } });
    req.on("error", reject);
  });
  const ip = ipOf(req);

  try {
    /* 注册 */
    if (p === "/register" && req.method === "POST") {
      if (!rateLimit(`reg:${ip}`, 3, 3600_000)) return send(429, { ok: false, error: "注册太频繁，请一小时后再试" });
      const body = await readBody();
      const username = String(body.username || "").trim();
      if (!usernameOk(username)) return send(400, { ok: false, error: "用户名需 3~24 位字母/数字/下划线/连字符" });
      if (!passwordOk(body.password)) return send(400, { ok: false, error: "密码至少 8 位" });
      if (db.users.some((u) => u.username === username)) return send(409, { ok: false, error: "用户名已被占用" });
      const user = makeUser(username, body.password, "user");
      db.users.push(user); persist();
      return send(200, { ok: true, token: issueSession(username), account: publicView(user) });
    }

    /* 登录 */
    if (p === "/login" && req.method === "POST") {
      if (!rateLimit(`login-ip:${ip}`, 10, 5 * 60_000)) return send(429, { ok: false, error: "尝试过多，请几分钟后再来" });
      const body = await readBody();
      const username = String(body.username || "").trim();
      const user = db.users.find((u) => u.username === username);
      if (!user) return send(401, { ok: false, error: "用户名或密码不对" });
      if (user.disabled) return send(403, { ok: false, error: "该账号已被停用，联系管理员" });
      if (Date.now() < user.lockUntil) return send(429, { ok: false, error: "该账号已被临时锁定，稍后再试" });
      if (!rateLimit(`login-u:${username}`, 5, 15 * 60_000)) {
        user.lockUntil = Date.now() + 15 * 60_000; persist();
        return send(429, { ok: false, error: "失败次数过多，账号锁定 15 分钟" });
      }
      if (!verifyPassword(user, body.password)) {
        user.failCount = (user.failCount || 0) + 1; persist();
        return send(401, { ok: false, error: "用户名或密码不对" });
      }
      user.failCount = 0; user.lastLogin = Date.now(); persist();
      return send(200, { ok: true, token: issueSession(username), account: publicView(user) });
    }

    /* 以下都要会话 */
    const me = sessionUser(req);

    /* 配对票据：网页用账号会话换一张一次性票据（这就是"先注册"落成硬约束的那一步） */
    if (p === "/pair-ticket" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      if (!rateLimit(`ticket-ip:${ip}`, 30, 5 * 60_000)) return send(429, { ok: false, error: "请求过于频繁，稍后再试" });
      const { ticket, exp } = issueTicket(me.username);
      return send(200, { ok: true, ticket, expiresAt: exp, username: me.username });
    }
    /* 核销：**用户本机的伴生服务**调用（非浏览器 ⇒ 无 Origin ⇒ 上面的 Origin 闸放行）。
       ⛔ 不要求会话：本机没有账号会话，它只有这张票据。 */
    if (p === "/pair-ticket/verify" && req.method === "POST") {
      if (!rateLimit(`verify-ip:${ip}`, 60, 5 * 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const body = await readBody();
      const result = verifyTicket(body && body.ticket);
      return send(200, result.ok
        ? { ok: true, username: result.username }
        : { ok: false, reason: result.reason });
    }
    /* 账号状态查询：本机侧定时来核销，账号被**停用**后要让已签发的令牌失效
       （否则"停用"只管得住新配对，管不住已经在用的会话）。 */
    if (p === "/pair-ticket/status" && req.method === "GET") {
      if (!rateLimit(`status-ip:${ip}`, 120, 5 * 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const names = String(url.searchParams.get("usernames") || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
      const accounts = {};
      for (const name of names) {
        const user = db.users.find((u) => u.username === name);
        accounts[name] = { exists: Boolean(user), disabled: !user || Boolean(user.disabled) };
      }
      return send(200, { ok: true, accounts });
    }

    /* ── 设备绑定（10-13 二期）：本机码 → 云端匹配 → 下发设备 token ──────────
       这是「账号」从摆设变成有实际价值的第一步：绑定了设备，本机才有资格连服务器
       （拉更新 / 将来的云端会话索引 —— 方案 A+ 的挂点）。 */
    if (p === "/device/claim" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      if (!rateLimit(`claim-ip:${ip}`, 30, 5 * 60_000)) return send(429, { ok: false, error: "请求过于频繁，稍后再试" });
      const body = await readBody();
      const result = claimDevice(body && body.code, me.username, body && body.name, body && body.machineId);
      if (!result.ok && result.reason === "device-limit") {
        return send(409, { ok: false, error: "device-limit", message: `每个账号最多绑定 ${result.limit} 台电脑（当前已有 ${result.current} 台）。请先在用户中心删除一台已绑定机器，再绑定新机器。`, limit: result.limit, current: result.current });
      }
      if (!result.ok) return send(400, { ok: false, error: result.reason });
      return send(200, { ok: true, device: result.device, account: publicView(me) });
    }
    /* 本机轮询：码即凭据（无网页会话）。账号停用 ⇒ 拒绝下发。 */
    /* ⛔ 按**机器**查询认领状态（10-14 修复回调超时）：本机用 installation_id 轮询，
       不再依赖"当前码" —— 用户手填旧码认领时，本机也能凭机器标识接上（码只是握手）。 */
    if (p === "/device/status" && req.method === "GET") {
      const mid = String(url.searchParams.get("machineId") || "").trim().slice(0, 64);
      const code = String(url.searchParams.get("code") || "").trim().toLowerCase();
      let device = null;
      let hitHash = "";
      if (mid) {
        for (const [hash, row] of Object.entries(db.devices)) if (row.machineId === mid) { device = row; hitHash = hash; break; }
      }
      if (!device && DEVICE_CODE_RE.test(code)) {
        const hash = deviceCodeHash(code);
        if (db.devices[hash]) { device = db.devices[hash]; hitHash = hash; }
      }
      if (!device) return send(200, { ok: true, claimed: false });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(200, { ok: true, claimed: true, reason: "account-disabled" });
      device.lastSeen = Date.now();
      persist();
      return send(200, { ok: true, claimed: true, username: device.username, name: device.name, id: deviceIdOf(hitHash), token: deviceTokenOf(deviceTokenBaseOf(device)) });
    }
    if (p === "/device/claim-status" && req.method === "GET") {
      if (!rateLimit(`devstatus-ip:${ip}`, 120, 5 * 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const result = redeemDeviceCode(url.searchParams.get("code"));
      if (!result.claimed) return send(200, { ok: true, claimed: false });
      if (!result.ok) return send(403, { ok: false, error: result.reason });
      return send(200, { ok: true, claimed: true, token: result.token, username: result.username, device: { id: result.id, name: result.name } });
    }
    /* 用户中心：我的设备列表 */
    if (p === "/devices" && req.method === "GET") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      return send(200, { ok: true, devices: listDevices(me.username) });
    }
    /* 用户中心：吊销设备（token 随之失效） */
    if (p === "/device/revoke" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const gone = revokeDevice(me.username, body && body.id);
      return gone ? send(200, { ok: true }) : send(404, { ok: false, error: "设备不存在" });
    }

    /* ── ⑤ 设备令牌通道：心跳（账号状态轮询用）+ 更新检查 ───────────────────── */
    /* 设备令牌版的列表/吊销：本机只有**设备令牌**（没有网页会话）⇒ 面板的「设备/座位」
       必须能用设备令牌查到同一个账号名下的设备（否则列表恒空 —— 10-14 实测现象）。 */
    if (p === "/device/list" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(403, { ok: false, error: "account-disabled" });
      const selfHash = Object.entries(db.devices).find(([, d]) => d === device)?.[0] || "";
      return send(200, {
        ok: true,
        account: device.username,
        devices: listDevices(device.username).map((d) => ({ ...d, current: d.id === deviceIdOf(selfHash) })),
      });
    }
    if (p === "/device/revoke-by-token" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const gone = revokeDevice(device.username, body && body.id);
      return gone ? send(200, { ok: true }) : send(404, { ok: false, error: "设备不存在" });
    }
    /* ── 模型目录同步（WBM → 本服务）────────────────────────────────────────────
       拉 WBM /api/model-catalog，归一化成客户端要的字段；credits（积分倍率）原样保留 ——
       ⛔ 倍率是"消耗速度随模型而定"的**唯一真相源**，本服务只转发不重写。 */
    async function pullModelCatalog(force = false) {
      const fresh = Date.now() - Number(db.modelCatalog.syncedAt || 0) < MODEL_SYNC_TTL_MS;
      if (!force && fresh && Array.isArray(db.modelCatalog.list) && db.modelCatalog.list.length) return { ok: true, cached: true };
      if (!WBM_BASE || !WBM_TOKEN) return { ok: false, error: "wbm-not-configured" };
      try {
        const r = await fetch(`${WBM_BASE}/api/model-catalog?realm=cn`, { headers: { Authorization: `Bearer ${WBM_TOKEN}` } });
        if (!r.ok) return { ok: false, error: `wbm-http-${r.status}` };
        const data = await r.json();
        const list = (data.models || []).map((m) => ({
          id: String(m.id || "").trim(),
          name: String(m.name || m.id || "").trim(),
          description: String(m.description || "").slice(0, 200),
          credits: String(m.credits || "").trim(),
          tags: Array.isArray(m.tags) ? m.tags.slice(0, 6).map(String) : [],
          series: String(m.series || ""),
          contextLength: Number(m.context_length || 0) || null,
          maxOutputTokens: Number(m.max_output_tokens || 0) || null,
          supportsImages: Boolean(m.supports_images),
          supportsReasoning: Boolean(m.supports_reasoning),
        })).filter((m) => m.id);
        db.modelCatalog = { syncedAt: Date.now(), realm: String(data.realm || "cn"), source: String(data.source_label || data.source || "wbm"), list };
        persist();
        return { ok: true, count: list.length, syncedAt: db.modelCatalog.syncedAt };
      } catch (error) {
        /* ⛔ 出错信息可能含 URL/凭据（fetch 的 TypeError 会把地址带进来）⇒ 必须脱敏 */
        return { ok: false, error: "wbm-unreachable", message: sanitize(error && error.message) };
      }
    }

    /* ── 云端同步 API（设备令牌鉴权：本机上传；会话令牌：用户在网页查看/删除） ───────── */
    function syncAuth() {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (device) return { username: device.username, machineId: device.machineId || "", device };
      if (me) return { username: me.username, machineId: "", device: null };
      return null;
    }
    if (p === "/sync/usage" && req.method === "GET") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const used = syncUsageBytes(who.username);
      const index = readSyncIndex(who.username);
      const devices = listDevices(who.username).length;
      return send(200, {
        ok: true, usedBytes: used, limitBytes: STORAGE_LIMIT_BYTES,
        sessions: Object.keys(index).length, devices, deviceLimit: DEVICE_LIMIT,
      });
    }
    if (p === "/sync/index" && req.method === "GET") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const index = readSyncIndex(who.username);
      const rows = Object.values(index)
        .map((r) => ({ id: r.id, title: r.title || "", project: r.project || "", machineName: r.machineName || "", machineId: r.machineId || "", lines: r.lines || 0, sizeBytes: r.sizeBytes || 0, uploadedAt: r.uploadedAt || 0, updatedAt: r.updatedAt || r.uploadedAt || 0 }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return send(200, { ok: true, sessions: rows, usedBytes: syncUsageBytes(who.username), limitBytes: STORAGE_LIMIT_BYTES });
    }
    /* 取单会话正文（设备令牌或网页会话都可）：本机"下载/恢复"与网页查看都用它。
       返回原始 jsonl 文本 + 元数据，客户端按行落回本地 sessions 目录（与本地同构）。 */
    if (p === "/sync/session" && req.method === "GET") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const id = String(url.searchParams.get("id") || "").trim();
      const index = readSyncIndex(who.username);
      const row = index[id];
      if (!row) return send(404, { ok: false, error: "not-found" });
      let content = "";
      try { content = fs.readFileSync(path.join(syncUserDir(who.username), "sessions", id + ".jsonl"), "utf8"); }
      catch { return send(404, { ok: false, error: "file-missing" }); }
      return send(200, { ok: true, id, meta: row, content });
    }
    if (p === "/sync/push" && req.method === "POST") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!who.device) return send(403, { ok: false, error: "device-token-required" });
      const body = await readBodyLarge();
      const incoming = Array.isArray(body && body.sessions) ? body.sessions : [];
      const index = readSyncIndex(who.username);
      let used = syncUsageBytes(who.username);
      const results = [];
      for (const item of incoming) {
        const id = String(item && item.id || "").trim();
        if (!id) continue;
        const lines = Array.isArray(item.lines) ? item.lines.map((l) => String(l)) : [];
        const from = Math.max(0, Number(item.fromOrdinal || 0));
        const dir = path.join(syncUserDir(who.username), "sessions");
        const file = path.join(dir, id + ".jsonl");
        const prev = index[id] || { lines: 0, sizeBytes: 0, uploadedAt: 0 };
        const prevBytes = Number(prev.sizeBytes || 0);
        const addBytes = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
        /* ⛔ 配额：超限就**不写这一条**并如实回报 —— 绝不留半截数据（客户端据此提示"已达上限"）。 */
        if (used + addBytes > STORAGE_LIMIT_BYTES) {
          results.push({ id, ok: false, error: "quota-exceeded", needBytes: addBytes, usedBytes: used, limitBytes: STORAGE_LIMIT_BYTES });
          continue;
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          if (lines.length) fs.appendFileSync(file, lines.join("\n") + "\n");
        } catch (error) {
          results.push({ id, ok: false, error: "write-failed", message: error.message });
          continue;
        }
        used += addBytes;
        index[id] = {
          id, lines: Number(prev.lines || 0) + lines.length, sizeBytes: prevBytes + addBytes,
          title: String(item.title || prev.title || "").slice(0, 200),
          project: String(item.project || prev.project || "").slice(0, 200),
          machineId: who.machineId || prev.machineId || "",
          machineName: String(who.device && who.device.name || prev.machineName || "").slice(0, 64),
          uploadedAt: prev.uploadedAt || Date.now(), updatedAt: Date.now(),
        };
        results.push({ id, ok: true, lines: index[id].lines, sizeBytes: index[id].sizeBytes });
      }
      writeSyncIndex(who.username, index);
      return send(200, { ok: true, results, usedBytes: used, limitBytes: STORAGE_LIMIT_BYTES });
    }
    if (p === "/sync/delete" && req.method === "POST") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const index = readSyncIndex(who.username);
      const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
      const project = String(body && body.project || "");
      const targets = Object.keys(index).filter((id) => (ids.includes(id)) || (project && index[id] && index[id].project === project));
      for (const id of targets) {
        try { fs.rmSync(path.join(syncUserDir(who.username), "sessions", id + ".jsonl"), { force: true }); } catch { /* 忽略 */ }
        delete index[id];
      }
      writeSyncIndex(who.username, index);
      return send(200, { ok: true, deleted: targets.length, usedBytes: syncUsageBytes(who.username), limitBytes: STORAGE_LIMIT_BYTES });
    }
    /* ── 内置供应商「限时福利」：模型列表（含每模型积分倍率）+ 生效勾选 ───────── */
    if (p === "/models" && req.method === "GET") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const pulled = await pullModelCatalog(false);
      const enabled = new Set(Array.isArray(db.userModels[me.username]) ? db.userModels[me.username] : []);
      const models = (db.modelCatalog.list || []).map((m) => ({ ...m, enabled: enabled.has(m.id) }));
      return send(200, {
        ok: true,
        provider: {
          id: BUILTIN_PROVIDER_ID,
          name: BUILTIN_PROVIDER_NAME,
          /* ⛔ 只给**同源代理路径**：客户端永不接触上游真实地址与网关密钥。
             真实地址与 wbk_ 密钥只存在本服务（凭据目录）并由代理在服务端注入。 */
          baseUrl: BUILTIN_PROXY_PATH,
          ready: Boolean(WBM_BASE && WBM_GATEWAY_KEY),
          /* 客户端据此决定是否要调 /proxy/token 签发（明文只在那一次响应里） */
          hasProxyToken: Boolean(db.proxyTokens[me.username]),
        },
        models,
        enabledCount: enabled.size,
        total: models.length,
        syncedAt: db.modelCatalog.syncedAt,
        realm: db.modelCatalog.realm,
        source: db.modelCatalog.source,
        sync: pulled.ok ? "ok" : pulled.error,
      });
    }
    /* 勾选生效模型：整集覆盖（前端去抖后提交全量），只接受目录里存在的 id */
    if (p === "/models/enabled" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const known = new Set((db.modelCatalog.list || []).map((m) => m.id));
      const ids = Array.isArray(body && body.ids) ? body.ids.map(String).filter((id) => known.has(id)) : [];
      db.userModels[me.username] = Array.from(new Set(ids));
      persist();
      return send(200, { ok: true, enabledCount: db.userModels[me.username].length, enabled: db.userModels[me.username] });
    }
    /* 签发 / 轮换本用户的代理令牌（会话鉴权）。明文**仅此一次**返回，之后无法再取。 */
    if (p === "/proxy/token" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const token = PROXY_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
      db.proxyTokens[me.username] = { hash: hashProxyToken(token), prefix: token.slice(0, 12), createdAt: Date.now(), lastUsedAt: 0, ips: [] };
      persist();
      console.log(`[proxy] 已为账号 ${me.username} 签发代理令牌 ${token.slice(0, 12)}…[已脱敏]`);
      return send(200, { ok: true, token, prefix: token.slice(0, 12), note: "明文仅此一次，请客户端立即保存到本机配置" });
    }
    /* 代理转发的目标：OpenAI 兼容的对话接口（流式原样透传）。
       ⛔ 上游真实地址与网关密钥**只在这里**出现，绝不回传客户端；
       ⛔ 未配置网关密钥时如实 503，不静默降级。 */
    if ((p === "/proxy/v1/chat/completions" && req.method === "POST") || (p === "/proxy/v1/models" && req.method === "GET")) {
      const header = String(req.headers.authorization || "");
      const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!presented || !presented.startsWith(PROXY_TOKEN_PREFIX)) {
        return send(401, { ok: false, error: "proxy-token-required" });
      }
      const hit = proxyUserByToken(presented);
      if (!hit) return send(401, { ok: false, error: "invalid-proxy-token" });
      const owner = db.users.find((u) => u.username === hit.username);
      if (!owner || owner.disabled) return send(403, { ok: false, error: "account-disabled" });
      /* 来源绑定：首次见到就记住，最多 PROXY_IP_LIMIT 个；超出直接拒（防令牌被转发给别人用） */
      const ip = ipOf(req);
      const ips = Array.isArray(hit.row.ips) ? hit.row.ips : [];
      if (!ips.includes(ip)) {
        if (ips.length >= PROXY_IP_LIMIT) return send(403, { ok: false, error: "proxy-ip-limit", message: "该令牌已在其它网络使用过，如需更换请重新签发" });
        ips.push(ip); hit.row.ips = ips;
      }
      hit.row.lastUsedAt = Date.now();
      persist();
      if (!WBM_BASE || !WBM_GATEWAY_KEY) return send(503, { ok: false, error: "upstream-not-configured" });
      /* 转发：只替换 Authorization，其余原样（模型、参数、流式标志） */
      const target = `${WBM_BASE}/v1/${p.endsWith("models") ? "models" : "chat/completions"}`;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: { Authorization: `Bearer ${WBM_GATEWAY_KEY}`, "Content-Type": String(req.headers["content-type"] || "application/json") },
          body: req.method === "POST" ? bodyBuf : undefined,
        });
        res.writeHead(upstream.status, { "Content-Type": String(upstream.headers.get("content-type") || "application/json"), "Cache-Control": "no-store" });
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch (error) {
        send(502, { ok: false, error: "upstream-unreachable", message: sanitize(error && error.message) });
      }
      return;
    }
    /* 管理员：立刻重新拉取模型目录（force 绕过缓存） */
    if (p === "/admin/models/sync" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const pulled = await pullModelCatalog(true);
      return send(pulled.ok ? 200 : 502, { ok: pulled.ok, ...pulled, total: (db.modelCatalog.list || []).length });
    }
    if (p === "/device/heartbeat" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(403, { ok: false, error: "account-disabled" });
      device.lastSeen = Date.now();
      persist();
      return send(200, { ok: true, account: user.username });
    }
    if (p === "/device/update/check" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(403, { ok: false, error: "account-disabled" });
      device.lastSeen = Date.now();
      persist();
      return send(200, { ok: true, ...readUpdateMeta() });
    }
    if (p === "/me" && req.method === "GET") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      return send(200, { ok: true, account: publicView(me) });
    }
    if (p === "/logout" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      if (header.startsWith("Bearer ")) { delete db.sessions[crypto.createHash("sha256").update(header.slice(7).trim()).digest("hex")]; persist(); }
      return send(200, { ok: true });
    }
    if (p === "/password" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      if (!verifyPassword(me, body.oldPassword || "")) return send(401, { ok: false, error: "原密码不对" });
      if (!passwordOk(body.newPassword)) return send(400, { ok: false, error: "新密码至少 8 位" });
      me.salt = crypto.randomBytes(16).toString("hex"); me.hash = hashPassword(body.newPassword, me.salt); persist();
      return send(200, { ok: true });
    }

    /* 管理员 */
    if (p.startsWith("/admin/")) {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const target = db.users.find((u) => u.username === decodeURIComponent(p.split("/")[3] || ""));
      if (p === "/admin/users" && req.method === "GET") {
        return send(200, { ok: true, users: db.users.map(publicView) });
      }
      if (!target) return send(404, { ok: false, error: "用户不存在" });
      if (target.username === me.username && p.endsWith("/delete")) return send(400, { ok: false, error: "不能删除自己" });
      if (p.endsWith("/disable") && req.method === "POST") { target.disabled = true; db.sessions = Object.fromEntries(Object.entries(db.sessions).filter(([, s]) => s.username !== target.username)); persist(); return send(200, { ok: true, account: publicView(target) }); }
      if (p.endsWith("/enable") && req.method === "POST") { target.disabled = false; target.lockUntil = 0; target.failCount = 0; persist(); return send(200, { ok: true, account: publicView(target) }); }
      if (p.endsWith("/reset-password") && req.method === "POST") {
        const body = await readBody();
        if (!passwordOk(body.password)) return send(400, { ok: false, error: "新密码至少 8 位" });
        target.salt = crypto.randomBytes(16).toString("hex"); target.hash = hashPassword(body.password, target.salt);
        target.failCount = 0; target.lockUntil = 0; persist();
        return send(200, { ok: true });
      }
      if (p.endsWith("/delete") && req.method === "POST") {
        db.users = db.users.filter((u) => u.username !== target.username);
        db.sessions = Object.fromEntries(Object.entries(db.sessions).filter(([, s]) => s.username !== target.username));
        persist();
        return send(200, { ok: true });
      }
    }

    return send(404, { ok: false, error: "not-found" });
  } catch (error) {
    return send(400, { ok: false, error: error.message === "bad-json" ? "请求格式不对" : error.message });
  }
});

/* ── CLI：签发管理员 ──────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
if (argv[0] === "--init-admin") {
  const [, username, password] = argv;
  if (!usernameOk(username) || !passwordOk(password)) {
    console.error("用法：node server.js --init-admin <用户名> <密码>（用户名 3~24 位字母数字；密码 ≥8 位）");
    process.exit(1);
  }
  if (db.users.some((u) => u.role === "admin")) { console.error("已存在管理员；如需再建，请先手动编辑数据文件。"); process.exit(1); }
  db.users.push(makeUser(username, password, "admin"));
  persist();
  console.log(`管理员「${username}」已创建 → ${DATA_FILE}`);
  process.exit(0);
}

console.log(
  "[wbm] 限时福利接入：" +
    (WBM_BASE && WBM_TOKEN ? "已配置（地址与 token 均来自凭据/环境，不落日志）" : "未配置（缺 WBM_BASE 或 wbm-token 凭据）") +
    "｜网关密钥：" + (WBM_GATEWAY_KEY ? "已配置" : "未配置")
);
server.listen(PORT, "127.0.0.1", () => console.log(`[accounts] 账号服务就绪 127.0.0.1:${PORT}（users=${db.users.length}, file=${DATA_FILE}）`));
