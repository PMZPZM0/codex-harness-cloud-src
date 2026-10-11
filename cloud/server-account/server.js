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

server.listen(PORT, "127.0.0.1", () => console.log(`[accounts] 账号服务就绪 127.0.0.1:${PORT}（users=${db.users.length}, file=${DATA_FILE}）`));
