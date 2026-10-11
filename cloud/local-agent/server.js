"use strict";
/**
 * Codex Harness Cloud · 本地伴生服务（local-agent）
 *
 *   node local-agent/server.js            # 接真引擎（需要本机有 codex 引擎 + 模型凭据）
 *   node local-agent/server.js --mock     # 接假引擎（演示 / 自测，无需 key）
 *
 * 定位（见 docs/CLOUD-VERSION.md 方案 A）：
 *   云端 = 界面资源 + 账号 + AI 网关；本地 = 数据 + 执行。
 *   本服务就是"本地"这一半的入口：它把本机引擎按一套**窄协议**（handshake / rpc / events /
 *   respond）暴露给浏览器，其余一律不做 —— 不存会话、不落地聊天记录、不碰账号库。
 *   界面资源**不在本服务里**（只有一份回落副本）：默认从云端 CDN 拉，所以"换界面 =
 *   重新部署云端资源"，用户不需要重装任何东西。这正是云化要解决的问题。
 *
 * ⛔ 安全：监听地址固定 127.0.0.1（绝不 0.0.0.0）。回环对任意网页可达，鉴权细节见 auth.js 顶部。
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const config = require("./config");
const { Pairing, authorize, corsHeaders, PAIR_CODE_TTL_MS } = require("./auth");
const { EngineAdapter } = require("./engine");
const { MockEngine } = require("./mock-engine");

const argv = process.argv.slice(2);
const USE_MOCK = argv.includes("--mock");
const OPEN_BROWSER = argv.includes("--open");

const cfg = config.load();
/**
 * web 资源目录。⛔ 允许被环境变量覆盖：
 *   打进单文件 exe（Node SEA）时资源是**内嵌**的，启动时解到磁盘再指过来。
 *   默认仍是源码旁的 cloud/web。
 */
const WEB_DIR = path.resolve(process.env.HARNESS_CLOUD_WEB_DIR || path.join(__dirname, "..", "web"));
const BODY_LIMIT = 512 * 1024;

// ── 日志：只写文件，且**绝不写 token / 配对码** ────────────────────────────────
const logStream = fs.createWriteStream(cfg.logFile, { flags: "a" });
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { logStream.write(line); } catch { /* 盘满了也不能影响服务 */ }
  if (process.env.HARNESS_CLOUD_QUIET !== "1") process.stdout.write(line);
}

// ── 引擎 ────────────────────────────────────────────────────────────────────
const engine = USE_MOCK
  ? new MockEngine({ log })
  : new EngineAdapter({ binary: cfg.engine.binary, codexHome: cfg.engine.codexHome, cwd: cfg.engine.cwd, log });

/** 事件环形缓冲：手机/弱网断流后重连要能补上断掉那段，否则界面会停在半句话上。 */
const RING_MAX = 400;
const ring = [];
let seq = 0;
const sseClients = new Set();

engine.on("event", (event) => {
  const frame = { seq: ++seq, at: Date.now(), ...event };
  ring.push(frame);
  if (ring.length > RING_MAX) ring.shift();
  const payload = `id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
});

// 允许直连的来源：本机两种写法 + 云端资产所在的 origin（云端页面直连本机时要靠它）
const allowedOrigins = [...cfg.allowedOrigins];
try {
  const cdnOrigin = new URL(cfg.cdnBase).origin;
  if (!allowedOrigins.includes(cdnOrigin)) allowedOrigins.push(cdnOrigin);
} catch { /* cdnBase 是相对路径就不加 */ }

const pairing = new Pairing(log);

// ── 路由工具 ────────────────────────────────────────────────────────────────
function sendJson(req, res, status, body) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req.headers.origin, allowedOrigins),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error("bad-json")); }
    });
    req.on("error", reject);
  });
}

/** SSE 断线重连：按 Last-Event-ID 从环形缓冲补发。 */
function replayFrom(lastId) {
  const id = Number(lastId);
  if (!Number.isFinite(id)) return [];
  return ring.filter((frame) => frame.seq > id);
}

/**
 * 允许浏览器端直接调用的引擎方法白名单。
 * ⛔ 白名单而不是黑名单：这套协议一改就可能多出高危方法（写文件 / 执行命令），
 *   黑名单会静默把新方法放行。只有下列六个是"跑一轮对话"必需的。
 */
const RPC_ALLOW = new Set([
  "thread/list",
  "thread/start",
  "thread/resume",
  "thread/unsubscribe",
  "turn/start",
  "turn/interrupt",
]);

function shellHtml() {
  const file = path.join(WEB_DIR, "index.html");
  const html = fs.readFileSync(file, "utf8");
  /**
   * ⛔⛔ 只**注入**一个全局覆盖项，不再替换文件里的占位符。
   *   原来的写法（replaceAll("__CDN_BASE__", …)）意味着这个文件**只在本地服务下发时才是完整的** ——
   *   而同一份文件也会被原样托管到云端当入口（https://ppz123.asia/cloud/），
   *   那时占位符没人换，`fetch("__CDN_BASE__/version.json")` 必然失败、回落 /local-assets 又 404，
   *   页面就永远停在首屏（真实事故）。现在文件里没有占位符，外壳自己算地址；
   *   这里的注入只是"告诉它云端在哪"（可选覆盖，缺了也能跑）。
   */
  const inject = `  <script>window.__CHC_CDN__ = ${JSON.stringify(cfg.cdnBase)};</script>\n`;
  return html.replace("</head>", `${inject}</head>`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** 本地副本（CDN 不可达时的回落）。只服务 web/ 内文件，防路径穿越。 */
function serveLocalAsset(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/local-assets\/?/, ""));
  const full = path.resolve(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR + path.sep) && full !== WEB_DIR) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(full).pipe(res);
  });
}

// ── 主处理 ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const p = url.pathname;
  const method = req.method || "GET";

  // 预检：只对白名单内的 Origin 放行（第三方页面拿不到允许头 ⇒ 浏览器拦下真实请求）
  if (method === "OPTIONS") {
    const headers = corsHeaders(req.headers.origin, allowedOrigins);
    if (!headers["Access-Control-Allow-Origin"]) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (p === "/api/health") {
    sendJson(req, res, 200, { ok: true, product: "codex-harness-cloud", protocolVersion: cfg.protocolVersion, engine: engine.status });
    return;
  }

  if (p === "/api/handshake") {
    const presented = String(req.headers.authorization || "").startsWith("Bearer ");
    sendJson(req, res, 200, {
      ok: true,
      product: "codex-harness-cloud",
      protocolVersion: cfg.protocolVersion,
      agentVersion: "0.1.0",
      mock: USE_MOCK,
      engine: { ...engine.status, binary: USE_MOCK ? "(mock)" : cfg.engine.binary || null },
      capabilities: {
        paired: presented,
        engineAvailable: USE_MOCK || Boolean(cfg.engine.binary),
        methods: [...RPC_ALLOW],
        /** 界面资源地址由服务端下发 ⇒ 前端不写死 CDN，换 CDN 只改本地配置 */
        cdnBase: cfg.cdnBase,
        pairingTtlMs: PAIR_CODE_TTL_MS,
        attachments: false,
      },
    });
    return;
  }

  // 配对：唯一不需要 token 的写接口（它就是为了换 token）。仍要过 Origin + 自定义头两道闸。
  if (p === "/api/pair" && method === "POST") {
    const denied = authorize(req, { token: cfg.token, allowedOrigins, requireToken: false, mutating: true });
    if (denied) return sendJson(req, res, denied.status, denied.body);
    let body;
    try { body = await readBody(req); } catch (error) { return sendJson(req, res, 400, { ok: false, error: error.message }); }
    const result = pairing.redeem(String(body.code || "").trim().toLowerCase());
    if (!result.ok) {
      log(`[pair] 配对失败：${result.reason}`);
      return sendJson(req, res, 403, { ok: false, error: result.reason });
    }
    log("[pair] 配对成功，已下发 token");
    sendJson(req, res, 200, { ok: true, token: cfg.token, protocolVersion: cfg.protocolVersion });
    return;
  }

  // ── 以下全部需要 token ───────────────────────────────────────────────────
  if (p === "/api/events") {
    const denied = authorize(req, { token: cfg.token, allowedOrigins });
    if (denied) return sendJson(req, res, denied.status, denied.body);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(req.headers.origin, allowedOrigins),
    });
    res.write(`retry: 2000\n\n`);
    // ⛔ hello 是"每连接一次"的问候，**不占用事件序号、也不带 id** ——
    //   它要是吃了号，断流重连的 Last-Event-ID 就会出现空洞，补发区间算不准。
    res.write(`data: ${JSON.stringify({ kind: "hello", protocolVersion: cfg.protocolVersion, engine: engine.status, lastSeq: seq, at: Date.now() })}\n\n`);
    for (const frame of replayFrom(req.headers["last-event-id"])) {
      res.write(`id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* 下面 close 会清理 */ }
    }, 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (p === "/api/rpc" && method === "POST") {
    const denied = authorize(req, { token: cfg.token, allowedOrigins, mutating: true });
    if (denied) return sendJson(req, res, denied.status, denied.body);
    let body;
    try { body = await readBody(req); } catch (error) { return sendJson(req, res, 400, { ok: false, error: error.message }); }
    const rpcMethod = String(body.method || "");
    if (!RPC_ALLOW.has(rpcMethod)) return sendJson(req, res, 403, { ok: false, error: "method-not-allowed", method: rpcMethod });
    try {
      const result = await engine.request(rpcMethod, body.params || {});
      sendJson(req, res, 200, { ok: true, result });
    } catch (error) {
      log(`[rpc] ${rpcMethod} 失败：${error.message}`);
      sendJson(req, res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (p === "/api/respond" && method === "POST") {
    const denied = authorize(req, { token: cfg.token, allowedOrigins, mutating: true });
    if (denied) return sendJson(req, res, denied.status, denied.body);
    let body;
    try { body = await readBody(req); } catch (error) { return sendJson(req, res, 400, { ok: false, error: error.message }); }
    if (body.id === undefined) return sendJson(req, res, 400, { ok: false, error: "missing-id" });
    try {
      engine.respond(body.id, body.result === undefined ? {} : body.result);
      sendJson(req, res, 200, { ok: true });
    } catch (error) {
      sendJson(req, res, 502, { ok: false, error: error.message });
    }
    return;
  }

  // ── 页面与资源 ───────────────────────────────────────────────────────────
  if (method === "GET" && (p === "/" || p === "/index.html")) {
    let html;
    try { html = shellHtml(); } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(`外壳缺失：${error.message}`);
      return;
    }
    // 外壳必须 no-store：它只含"资产从哪来"的指针，缓存住会把用户钉在旧资产上
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }

  if (method === "GET" && p.startsWith("/local-assets/")) {
    serveLocalAsset(res, p);
    return;
  }

  if (method === "GET" && (p === "/favicon.ico" || p === "/favicon.svg")) {
    res.writeHead(204).end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
});

/**
 * 端口被占用时的处理：**先问是不是自己已经在跑**。
 * ⛔ 为什么必须有：用户双击图标两次、或者开机自启 + 手动打开 —— 很常见。
 *   如果这里直接抛 EADDRINUSE，第二次点击就是一个报错窗口，看起来像"坏了"。
 *   是自己人（/api/health 认出 product）就只把浏览器打开、安静退出；
 *   是别的程序占着端口才真的报错，并把端口号说清楚。
 */
server.on("error", async (error) => {
  if (error.code !== "EADDRINUSE") {
    log(`[boot] 监听失败：${error.message}`);
    process.stdout.write(`\n  监听 ${cfg.port} 失败：${error.message}\n\n`);
    process.exit(1);
    return;
  }
  const base = `http://127.0.0.1:${cfg.port}`;
  let product = "";
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
    product = String(((await response.json()) || {}).product || "");
  } catch { /* 拿不到就当它不是我们 */ }
  if (product === "codex-harness-cloud") {
    log(`[boot] ${cfg.port} 上已经有一个本机伴生服务在跑，本次只打开界面。`);
    process.stdout.write(`\n  本机伴生服务已经在运行（${base}），直接打开界面。\n\n`);
    openBrowser(base + "/");
    process.exit(0);
    return;
  }
  log(`[boot] 端口 ${cfg.port} 被别的程序占用了`);
  process.stdout.write(
    `\n  端口 ${cfg.port} 被别的程序占用，本机伴生服务起不来。\n` +
    `  换端口：设置环境变量 HARNESS_CLOUD_PORT=其他端口 再启动。\n\n`
  );
  process.exit(1);
});

server.listen(cfg.port, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${cfg.port}`;
  log(`[boot] Codex Harness Cloud · 本地伴生服务已启动 ${base}（${USE_MOCK ? "假引擎" : "真引擎"}）`);
  log(`[boot] 界面资源：${cfg.cdnBase}（不可达时回落到本地副本）`);
  log(`[boot] 引擎：${USE_MOCK ? "mock" : cfg.engine.binary || "未找到 —— 设置 HARNESS_CODEX_BINARY"}`);
  log(`[boot] CODEX_HOME：${cfg.engine.codexHome}`);
  // 配对码只打在控制台：能看到这行输出的人才配得上这台机器
  printPairBanner(base, pairing.issue());
  /**
   * 配对码过期就自动续一个新的并重新打印。
   * ⛔ 为什么需要：服务可能一开就是几小时，而配对码 5 分钟有效、还是一次性的。
   *   没有这个续期，用户十分钟后再来看控制台就只有一行"已过期"，只能重启服务 ——
   *   一个"必须重启才能登录"的入口，注定会被用错（往配置里写死 token）。
   */
  setInterval(() => {
    if (pairing.expiresInMs > 0) return;
    if (issuedCount > 1 && Date.now() - lastIssuedAt > 24 * 60 * 60_000) return;   // 长期无人配对就别刷屏
    printPairBanner(base, pairing.issue());
  }, 20_000).unref();
  if (OPEN_BROWSER) openBrowser(`${base}/?pair=${pairing.code}`);
  if (!USE_MOCK) {
    engine.start().catch((error) => log(`[boot] 引擎启动失败（可稍后在界面上重试）：${error.message}`));
  } else {
    engine.start().catch(() => { /* mock 不会失败 */ });
  }
});

let issuedCount = 0;
let lastIssuedAt = 0;
function printPairBanner(base, code) {
  issuedCount += 1;
  lastIssuedAt = Date.now();
  process.stdout.write(`\n  ┌───────────────────────────────────────────────┐\n`);
  process.stdout.write(`  │  配对码： ${code}   （${Math.round(PAIR_CODE_TTL_MS / 60000)} 分钟内有效，一次性）\n`);
  process.stdout.write(`  │  打开：   ${base}/?pair=${code}\n`);
  process.stdout.write(`  └───────────────────────────────────────────────┘\n\n`);
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (error) {
    log(`[boot] 自动打开浏览器失败（不影响使用）：${error.message}`);
  }
}

async function shutdown(signal) {
  log(`[exit] 收到 ${signal}，正在收尾`);
  for (const client of sseClients) { try { client.end(); } catch { /* 忽略 */ } }
  await engine.stop().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
