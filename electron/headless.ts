/**
 * Codex Harness · 无头主进程入口（网页版真界面的地基）
 *
 * ⛔ 设计：跑**真的 main.ts**（86 个 IPC 域 / 真引擎 / 全部业务都在），只改三件事：
 *   ① ipcMain.handle/on 在**域注册之前**被包一层 ⇒ 441 个通道的 handler 全部被捕获，
 *      交给 HTTP 桥按 {channel, args} 分发 —— 浏览器里的 shim 因此与桌面渲染层
 *      走**完全相同**的主进程代码路径。
 *   ② BrowserWindow 构造：一律 show:false（无头），且实例 webContents.send 被
 *      包一层 ⇒ 主进程推给渲染层的**每一条事件**（harness:event / voice:event / …）
 *      同时广播给浏览器 SSE 客户端。
 *   ③ 顺带起一个静态服务：托管仓库 dist/（桌面版真界面的构建产物）+ 注入浏览器
 *      端 shim —— shim 由 manifest(441 方法) + preload.ts(24 事件桥) **运行时生成**，
 *      与桌面版永不脱节（gen:ipc 改了 manifest 这里自动跟）。
 *
 * ⛔ 时机：patch 必须发生在 `require("./main")` **之前** —— main 的域模块在
 *    import 时就注册 handler（顶层副作用），晚了就漏。
 * ⛔ 安全：本服务只绑 127.0.0.1。与伴生服务的鉴权合并是下一阶段（先打通真界面）。
 */
import electron from "electron";
import { app, ipcMain } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";

// ⛔ 本机 GPU 进程必崩（exit_code=-1073741819），崩 9 次后整个进程 FATAL 退出 ——
//   与走查台同一配方，必须在 app 就绪**之前**挂上。
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

const PORT = Number(process.env.HARNESS_HEADLESS_PORT || 8917);
const DIST_DIR = process.env.HARNESS_DIST_DIR || join(__dirname, "..", "dist");
const MANIFEST_FILE = join(__dirname, "..", "electron", "ipc-channels.manifest.json");
const PRELOAD_FILE = join(__dirname, "..", "electron", "preload.ts");

/* ── ① 包 ipcMain：捕获全部通道 handler（在 main 的域模块注册前）──────────── */
const invokeHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>();

type IpcMainLike = { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => unknown; on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown };
const ipcMainLike = ipcMain as unknown as IpcMainLike;
const origHandle = ipcMainLike.handle.bind(ipcMain);
const origOn = ipcMainLike.on.bind(ipcMain);
ipcMainLike.handle = (channel, listener) => {
  invokeHandlers.set(channel, listener);
  return origHandle(channel, listener);
};
ipcMainLike.on = (channel, listener) => {
  onHandlers.set(channel, listener);
  return origOn(channel, listener);
};

/* ── ② 包 BrowserWindow：无头 + 事件广播 ─────────────────────────────────── */
type WSEvent = { event: string; payload: unknown };
const sseClients = new Set<ServerResponse>();
function broadcast(event: WSEvent) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(frame); } catch { sseClients.delete(client); }
  }
}

/* ⛔ electron 模块的 BrowserWindow 属性是**只读 getter**（赋值/defineProperty 都被拒，
   实测两层全试过）⇒ 无法在构造层面替换。兜底：监听 app 的 browser-window-created ——
   每个窗口（主窗 / 宠物 / 弹出 / 截图遮罩）创建时立即隐藏 + 摘任务栏 + 包一层
   webContents.send（全部主→渲染事件由此广播给浏览器 SSE）。 */
app.on("browser-window-created", (_event: unknown, win: { hide: () => void; setSkipTaskbar: (v: boolean) => void; webContents: { send: (channel: string, ...args: unknown[]) => void } }) => {
  try { win.hide(); win.setSkipTaskbar(true); } catch { /* 忽略 */ }
  const wc = win.webContents;
  const origSend = wc.send.bind(wc);
  wc.send = (channel: string, ...args: unknown[]) => {
    broadcast({ event: channel, payload: args.length <= 1 ? args[0] : args });
    return origSend(channel, ...args);
  };
});

/* ── ③ shim 生成：manifest(441 invoke) + preload.ts(24 事件桥) ────────────── */
type ManifestEntry = { name: string; channel: string; paramsDecl: string | null; invokeArgs: string | null };
type OnEntry = { name: string; channel: string };

function parseOnChannels(preloadSource: string): OnEntry[] {
  const out = new Map<string, string>();
  const re = /on([A-Za-z0-9]+):\s*\([\s\S]{0,400}?\)\s*=>\s*__on\("([^"]+)"/g;
  for (const match of preloadSource.matchAll(re)) {
    const name = `on${match[1]}`;
    if (!out.has(name)) out.set(name, match[2]);
  }
  return [...out].map(([name, channel]) => ({ name, channel }));
}

/** 参数默认值表：paramsDecl 里 `name: type = default` 的 default（只认字面量）。 */
function parseDefaults(paramsDecl: string | null): unknown[] {
  if (!paramsDecl) return [];
  const defaults: unknown[] = [];
  for (const part of paramsDecl.split(",")) {
    const match = /=\s*(\{|\[|"[^"]*"|'[^']*'|\d+|true|false|null)\s*$/.exec(part.trim());
    if (!match) { defaults.push(undefined); continue; }
    const token = match[1];
    defaults.push(token === "{" ? {} : token === "[" ? [] : token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token === "true" ? true : token === "false" ? false : token === "null" ? null : Number(token));
  }
  return defaults;
}

function buildShim(manifest: { channels: ManifestEntry[] }, onChannels: OnEntry[]): string {
  return `/* 自动生成（electron/headless.ts）—— 浏览器端 window.codex，与桌面 preload 同源同形 */
(function () {
  "use strict";
  var listeners = {};           // channel → Set<listener>
  var nextId = 1;
  var pending = {};             // id → {resolve, reject}

  function emit(payload) {
    var set = listeners[payload.event];
    if (!set) return;
    for (var fn of set) { try { fn(payload.payload); } catch (e) { console.error("[shim] listener", payload.event, e); } }
  }
  function connect() {
    var es = new EventSource("/__events");
    es.onmessage = function (m) { try { emit(JSON.parse(m.data)); } catch (e) { /* 忽略坏帧 */ } };
    es.onerror = function () { es.close(); setTimeout(connect, 1200); };   // 断线重连
  }
  connect();

  function invoke(channel, args) {
    return new Promise(function (resolve, reject) {
      var id = String(nextId++);
      pending[id] = { resolve: resolve, reject: reject };
      fetch("/__ipc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id, channel: channel, args: args }),
      }).then(function (r) { return r.json(); }).then(function (body) {
        var entry = pending[id]; if (!entry) return;
        delete pending[id];
        if (body.ok) entry.resolve(body.result);
        else { var err = new Error(body.error && body.error.message || "ipc failed"); err.name = body.error && body.error.name || "Error"; entry.reject(err); }
      }).catch(function (e) { var entry = pending[id]; delete pending[id]; entry && entry.reject(e); });
    });
  }
  function subscribe(channel, listener) {
    (listeners[channel] = listeners[channel] || new Set()).add(listener);
    return function () { listeners[channel].delete(listener); };
  }

  var codex = {};
  /* ⛔ 浏览器没有原生文件对话框 ⇒ 选图改写为 <input type=file> + 上传（≤2MB，
     服务端同样硬卡）。返回本地路径，与桌面版选图同形；预览用的自定义协议在
     浏览器没有对应物，预览可能不显示（发送不受影响）—— 下一阶段接 HTTP 文件读。 */
  function pickFiles(accept, multiple, isImage) {
    return new Promise(function (resolve) {
      var input = document.createElement("input");
      input.type = "file"; input.accept = accept; input.multiple = !!multiple; input.style.display = "none";
      document.body.appendChild(input);
      input.onchange = function () {
        var files = Array.prototype.slice.call(input.files || []);
        if (!files.length) { input.remove(); resolve([]); return; }
        var tooBig = files.find(function (f) { return f.size > 2 * 1024 * 1024; });
        if (tooBig) { input.remove(); alert("图片「" + tooBig.name + "」超过 2MB 限制"); resolve([]); return; }
        Promise.all(files.map(function (f) {
          return fetch("/__upload", { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name) }, body: f })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (!j.ok) throw new Error(j.error || "上传失败"); return j.path; });
        })).then(function (paths) { input.remove(); resolve(paths); })
          .catch(function (e) { input.remove(); alert("上传失败：" + (e && e.message || e)); resolve([]); });
      };
      input.click();
    });
  }
  var CHANNELS = ${JSON.stringify(manifest.channels.map((c) => ({ name: c.name, channel: c.channel, invokeArgs: c.invokeArgs, defaults: parseDefaults(c.paramsDecl) })))};
  for (var entry of CHANNELS) {
    (function (entry) {
      var objectWrap = entry.invokeArgs && entry.invokeArgs.trim().startsWith("{");
      var argCount = entry.invokeArgs ? (objectWrap
        ? entry.invokeArgs.replace(/[{}]/g, "").split(",").filter((s) => s.trim()).length
        : entry.invokeArgs.split(",").length) : 0;
      codex[entry.name] = function () {
        var args = [];
        for (var i = 0; i < argCount; i++) {
          var v = i < arguments.length ? arguments[i] : entry.defaults[i];
          args.push(v);
        }
        if (objectWrap) {
          var keys = entry.invokeArgs.replace(/[{}]/g, "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
          var obj = {};
          keys.forEach(function (k, i) { obj[k] = args[i]; });
          args = [obj];
        }
        return invoke(entry.channel, args);
      };
    })(entry);
  }
  var EVENTS = ${JSON.stringify(onChannels)};
  for (var ev of EVENTS) {
    (function (ev) { codex[ev.name] = function (listener) { return subscribe(ev.channel, listener); }; })(ev);
  }
  codex.chooseImages = function () { return pickFiles("image/*", true, true); };
  codex.chooseFiles = function () { return pickFiles("*/*", true, false); };

  window.codex = codex;
  window.__chcReady = true;   // 界面桥就位（外壳超时兜底读它）
})();
`;
}

/* ── ④ HTTP 桥：POST /__ipc（invoke）+ GET /__events（SSE）+ dist 静态 ────── */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function serveFile(res: ServerResponse, file: string) {
  const body = readFileSync(file);
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(body);
}

/* ── 云端选址（与登录门同一铁律：前置探测，不用 <link> 的 error 回退）────────
   跟随服务器更新的机制：真界面资产在 https://…/cloud/app/（version.json 带
   manifestSha256）。本机指纹与云端**一致**才用云端（协议匹配 = 可安全更新）；
   不一致或云端不可达 → 本地 dist 兜底。⇒ 站长重新传 /cloud/app/ = 全体用户刷新即新。 */
const CLOUD_APP_BASE = process.env.HARNESS_CLOUD_APP_BASE || "https://ppz123.asia/cloud/app";
const localManifestSha = (() => {
  try { return createHash("sha256").update(readFileSync(MANIFEST_FILE)).digest("hex").slice(0, 16); } catch { return ""; }
})();

function shellHtml(shimJs: string, assetBase: string) {
  // ⛔ 本地 index.html 的资源是相对路径（./assets/...）——用云端资产时必须改写基址。
  //   注入 <base> 会影响相对链接（icon 等），这里直接把 ./ 前缀替换成资产基址。
  const html = readFileSync(join(DIST_DIR, "index.html"), "utf8");
  const isCloud = assetBase !== "/__local";
  let rewritten = isCloud ? html.replace(/(src|href)="\.\//g, `$1="${assetBase}/`) : html;
  if (isCloud) {
    // ⛔ dist 自带 CSP（script-src 'self' …）会把跨源的云端资产全拦掉（实测：界面全空）。
    //   资产在云端时，把站点 Origin 加进 script/style 两个白名单 —— 放行的只有
    //   站长自己的服务器，不是放开任意外域。
    const cloudOrigin = new URL(assetBase).origin;
    rewritten = rewritten
      .replace(/script-src 'self'/g, `script-src 'self' ${cloudOrigin}`)
      .replace(/style-src 'self'/g, `style-src 'self' ${cloudOrigin}`);
  }
  const cdnMark = `<script>window.__CHC_CDN__ = ${JSON.stringify(assetBase)};</script>\n`;
  return rewritten.replace("</head>", `${cdnMark}<script>${shimJs}</script>\n</head>`);
}

function route(req: IncomingMessage, res: ServerResponse, shimJs: string) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const p = url.pathname;

  // ⛔ 传图通道（用户定调：限 2M）。浏览器 <input type=file> → 这里落盘 →
  //   返回本地路径，渲染层/引擎拿到的与桌面版选图**同形**（都是本地路径）。
  if (p === "/__upload" && req.method === "POST") {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > 2 * 1024 * 1024) {
      res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "图片超过 2MB 限制" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) { res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "图片超过 2MB 限制" })); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => {
      const filename = String(req.headers["x-file-name"] || "image.png").replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "image.png";
      const dir = join(app.getPath("userData"), "pasted-web");
      require("node:fs").mkdirSync(dir, { recursive: true });
      const target = join(dir, `${Date.now()}-${filename}`);
      require("node:fs").writeFileSync(target, Buffer.concat(chunks));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, path: target }));
    });
    return;
  }

  if (p === "/__events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ event: "__hello", payload: { at: Date.now() } })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (p === "/__ipc" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      let id = ""; let channel = ""; let args: unknown[] = [];
      try {
        const body = JSON.parse(raw);
        id = String(body.id ?? ""); channel = String(body.channel ?? ""); args = Array.isArray(body.args) ? body.args : [];
      } catch { res.writeHead(400).end(JSON.stringify({ id: "", ok: false, error: { message: "bad json" } })); return; }
      const handler = invokeHandlers.get(channel);
      if (!handler) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id, ok: false, error: { message: `no handler: ${channel}` } }));
        return;
      }
      try {
        // ⛔ ipcMain.handle 的 handler 首参是 IpcMainInvokeEvent；多数域不读它，
        //   少数读 sender —— 给一个无害假体（无头没有真 renderer）。
        const fakeEvent = { sender: { isDestroyed: () => true, send: () => undefined }, processId: -1, frameId: 0 };
        const result = await handler(fakeEvent, ...args);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id, ok: true, result }));
      } catch (error) {
        const err = error as Error;
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          id, ok: false,
          error: { message: err.message, name: err.name, code: (err as NodeJS.ErrnoException).code },
        }));
      }
    });
    return;
  }

  // dist 静态 + SPA 回退；index.html 走注入版
  let file = normalize(join(DIST_DIR, p === "/" ? "index.html" : p));
  if (!file.startsWith(normalize(DIST_DIR))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST_DIR, "index.html");
  if (file.endsWith("index.html")) {
    res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" }).end(shellHtml(shimJs, assetBaseCache));
    return;
  }
  serveFile(res, file);
}

/* ── ⑤ 启动顺序：先起桥，再进真 main（引擎等全部域由它拉起）──────────────── */
const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
const onChannels = parseOnChannels(readFileSync(PRELOAD_FILE, "utf8"));
const shimJs = buildShim(manifest, onChannels);

/* 云端选址：每 60s 重探一次 ⇒ 站长更新 /cloud/app/ 后，用户**下一次刷新页面**即新版，
   无需动本机任何东西。探测条件：version.json 可达 + protocolVersion 一致 +
   manifestSha256 与本机一致（UI 与主进程协议必须同源，否则本地兜底）。 */
let assetBaseCache = "/__local";
function probeAssetBase(): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  fetch(`${CLOUD_APP_BASE}/version.json?t=${Date.now()}`, { signal: controller.signal, cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((meta: { protocolVersion?: number; manifestSha256?: string }) => {
      clearTimeout(timer);
      if (Number(meta.protocolVersion) === 1 && meta.manifestSha256 === localManifestSha) {
        if (assetBaseCache !== CLOUD_APP_BASE) console.log(`[headless] 界面资产切到云端 ${CLOUD_APP_BASE}（跟随服务器更新）`);
        assetBaseCache = CLOUD_APP_BASE;
      } else {
        if (assetBaseCache !== "/__local") console.log(`[headless] 云端 UI 协议不匹配（远端 ${meta.manifestSha256} vs 本机 ${localManifestSha}）→ 本地兜底`);
        assetBaseCache = "/__local";
      }
    })
    .catch(() => {
      clearTimeout(timer);
      if (assetBaseCache !== "/__local") console.log("[headless] 云端不可达 → 本地兜底");
      assetBaseCache = "/__local";
    });
}
probeAssetBase();
setInterval(probeAssetBase, 60_000);

createServer((req, res) => route(req, res, shimJs)).listen(PORT, "127.0.0.1", () => {
  console.log(`[headless] 桥与界面就绪 http://127.0.0.1:${PORT}（dist=${DIST_DIR}，invoke=${manifest.channels.length}，events=${onChannels.length}）`);
});

// 真 main.ts：86 个域 / 真引擎 / 全部业务。⛔ 必须最后 require。
require("./main");
