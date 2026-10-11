"use strict";
/**
 * Codex Harness Cloud · 本地伴生服务 —— 鉴权与配对
 *
 * ⛔⛔ 先说清威胁模型，这是本文件每一行存在的理由：
 *   伴生服务监听在 127.0.0.1，但**本机回环对任何网页都是可达的** —— 用户浏览器打开任意
 *   一个第三方网站，那个网站的 JS 就能向 http://127.0.0.1:PORT 发请求。所以"只有本机能访问"
 *   **不等于"只有我们的界面能访问"**。四道闸，缺一不可：
 *
 *   ① 凭据走 `Authorization: Bearer <token>`，**不用 Cookie** —— 别的站点的请求不会自动携带，
 *      也不受 SameSite 影响（SameSite 只保护 Cookie，对 fetch 无用）。
 *   ② 状态变更请求必须带自定义头 `x-harness-client: web` —— 带自定义头 = 非简单请求 =
 *      浏览器**强制**先发 CORS 预检；预检由我们决定放不放行。这是唯一能挡住"第三方页面
 *      直接 POST 我们的接口"的机制（简单请求如 form/fetch 无头 POST 会绕过预检）。
 *   ③ Origin 白名单 —— 预检与真实请求都校验，纵深防御。
 *   ④ 配对码一次性 + 5 分钟 TTL + 最多 10 次尝试 + 常量时间比较 —— 防本机其它进程暴力枚举。
 *
 *   另：token 与配对码**绝不写日志**（日志可能被用户贴出去求助）。
 */
const crypto = require("node:crypto");

const PAIR_CODE_TTL_MS = 5 * 60_000;
const PAIR_CODE_MAX_TRIES = 10;
/** 配对码只由本地进程打印在控制台 —— 谁能看到那行输出，谁才配得上这台机器。 */
const PAIR_CODE_BYTES = 4;   // 8 位十六进制，够用且好念

/** 常量时间比较：长度不同直接 false（长度本身不是秘密，配对码长度固定）。 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

class Pairing {
  constructor(logger) {
    this.log = logger;
    this.code = null;
    this.issuedAt = 0;
    this.tries = 0;
  }

  /** 打印到控制台并返回码。已有未过期码时复用，避免刷屏。 */
  issue() {
    const now = Date.now();
    if (this.code && now - this.issuedAt < PAIR_CODE_TTL_MS) return this.code;
    this.code = crypto.randomBytes(PAIR_CODE_BYTES).toString("hex");
    this.issuedAt = now;
    this.tries = 0;
    return this.code;
  }

  get expiresInMs() {
    if (!this.code) return 0;
    return Math.max(0, this.issuedAt + PAIR_CODE_TTL_MS - Date.now());
  }

  /** 校验并**立即作废**（一次性）。返回 { ok, reason }。 */
  redeem(candidate) {
    if (!this.code) return { ok: false, reason: "no-code" };
    if (Date.now() - this.issuedAt > PAIR_CODE_TTL_MS) {
      this.code = null;
      return { ok: false, reason: "expired" };
    }
    if (this.tries >= PAIR_CODE_MAX_TRIES) {
      this.code = null;
      return { ok: false, reason: "too-many-tries" };
    }
    this.tries += 1;
    if (!candidate || !safeEqual(candidate, this.code)) {
      if (this.tries >= PAIR_CODE_MAX_TRIES) this.code = null;
      return { ok: false, reason: "mismatch" };
    }
    this.code = null;   // 一次性：成功即作废，重放无效
    return { ok: true };
  }
}

/**
 * 判断 Origin 是否可信。
 * ⛔ 不用 `startsWith(origin, allowed)`：`http://127.0.0.1:8917.evil.com` 会被前缀匹配放行。
 *   必须精确相等（协议+主机+端口），或命中的是显式配置的通配后缀条目。
 */
function originAllowed(origin, allowedOrigins) {
  if (!origin) return true;                 // 无 Origin：非浏览器发起（curl / 自测脚本）
  for (const entry of allowedOrigins) {
    if (entry === "*") return true;
    if (entry === origin) return true;
    // 形如 "https://*.example.com" 的通配：只比对主机后缀，且要求点是分割边界
    if (entry.startsWith("*.")) {
      try {
        const host = new URL(origin).hostname;
        const suffix = entry.slice(2);
        if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      } catch { /* origin 不是合法 URL → 不放行 */ }
    }
  }
  return false;
}

/**
 * 请求鉴权。返回 null 表示通过，否则返回 { status, body }。
 * opts.skipToken: 配对接口自己不带 token（它就是为了换 token）。
 */
function authorize(req, { token, allowedOrigins, requireToken = true, mutating = false }) {
  // ① Origin 白名单
  if (!originAllowed(req.headers.origin, allowedOrigins)) {
    return { status: 403, body: { ok: false, error: "origin-not-allowed" } };
  }
  // ② 状态变更必须带自定义头（触发预检；第三方简单请求绕不过）
  if (mutating) {
    const marker = String(req.headers["x-harness-client"] || "");
    if (marker !== "web") return { status: 403, body: { ok: false, error: "missing-client-header" } };
  }
  // ③ token
  if (requireToken) {
    const header = String(req.headers.authorization || "");
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented || !safeEqual(presented, token)) {
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
  }
  return null;
}

/** CORS 响应头：只回显白名单内的 Origin，永远不写 `*`（带凭据的接口不允许通配）。 */
function corsHeaders(origin, allowedOrigins) {
  if (!origin || !originAllowed(origin, allowedOrigins)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-harness-client",
    // ⛔ 云端页面（https://…）要去连本机回环时，Chrome 会先发一条**私有网络访问预检**
    //   （OPTIONS + Access-Control-Request-Private-Network: true），不回这个头它就把真实请求拦下。
    //   不加这个头的症状是"云端入口打开后一切正常，但怎么都连不上本机"。
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

module.exports = { Pairing, authorize, originAllowed, corsHeaders, safeEqual, PAIR_CODE_TTL_MS };
