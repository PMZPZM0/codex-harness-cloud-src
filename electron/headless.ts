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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";

// ⛔ 本机 GPU 进程必崩（exit_code=-1073741819），崩 9 次后整个进程 FATAL 退出 ——
//   与走查台同一配方，必须在 app 就绪**之前**挂上。
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

/* ⛔ 助手运行时标记（10-11）：更新源按产品线分开——助手只认 `cloud-v*` tag 与
 *   `CodexHarnessAssistant-*` 资产，绝不跟桌面版的 `v*` 串（同一仓库两条产品线）。
 *   必须在 require("./main") 之前打：域模块加载时就会读它。 */
process.env.HARNESS_ASSISTANT = "1";

const PORT = Number(process.env.HARNESS_HEADLESS_PORT || 8917);
const DIST_DIR = process.env.HARNESS_DIST_DIR || join(__dirname, "..", "dist");
const MANIFEST_FILE = join(__dirname, "..", "electron", "ipc-channels.manifest.json");
const PRELOAD_FILE = join(__dirname, "..", "electron", "preload.ts");

/* ⛔ app.getAppPath 修正：`electron dist-electron/headless.js` 启动时 getAppPath = dist-electron
   （主脚本所在目录），window-factory 的 loadFile(app.getAppPath()/dist/index.html) 与独立窗口
   全部 404（实测 ERR_FILE_NOT_FOUND）。改写为仓库根 = 桌面版 `electron .` 的同款路径。 */
try {
  const appLike = app as unknown as { getAppPath: () => string };
  const fixed = join(__dirname, "..");
  const patch = () => { appLike.getAppPath = () => fixed; };
  patch();
  if (appLike.getAppPath() !== fixed) { Object.defineProperty(app, "getAppPath", { value: () => fixed, configurable: true }); }
  console.log(`[headless] appPath 已校正 → ${appLike.getAppPath()}`);
} catch (error) { console.error("[headless] appPath 校正失败：", error); }

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
app.on("browser-window-created", (_event: unknown, win: { hide: () => void; setSkipTaskbar: (v: boolean) => void; show: () => void; showInactive: () => void; maximize: () => void; restore: () => void; focus: () => void; webContents: { send: (channel: string, ...args: unknown[]) => void } }) => {
  try { win.hide(); win.setSkipTaskbar(true); } catch { /* 忽略 */ }
  // ⛔ 只在创建时 hide 不够：window-factory 的 ready-to-show/托盘路径会再 show()（实测：白屏自愈页
  //   顶到用户屏幕上）。无头助手的窗口**永远不可见** ⇒ show/focus 一并短路。
  try {
    win.show = () => undefined;
    win.showInactive = () => undefined;
    win.maximize = () => undefined;
    win.restore = () => undefined;
    win.focus = () => undefined;
  } catch { /* 忽略 */ }
  const wc = win.webContents;
  const origSend = wc.send.bind(wc);
  wc.send = (channel: string, ...args: unknown[]) => {
    broadcast({ event: channel, payload: args.length <= 1 ? args[0] : args });
    return origSend(channel, ...args);
  };
});

/* ── ②b 对话框桥：能弹真弹，预置只作自动化后备 ───────────────────────────
   助手跑在用户本机 ⇒ **没有预置答案时直接弹真正的原生对话框**（窗口虽隐藏，
   原生对话框不依赖窗口可见，app-modal 照样出现在用户屏幕上）——与桌面版交互
   完全一致，绝对路径、trustPicked 全部走真实链路。预置答案队列（/__dialog）只
   供自动化/E2E 用。⛔ 远程场景（人不在机器前）对话框会没人点 ⇒ 设
   HARNESS_DIALOG_MODE=cancel 让无答案时直接按取消处理。 */
const dialogAnswers: Array<{ canceled: boolean; filePaths: string[] }> = [];
const DIALOG_MODE = process.env.HARNESS_DIALOG_MODE === "cancel" ? "cancel" : "native";
type DialogModule = {
  showOpenDialog: (...a: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (...a: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>;
};
const electronDialog = (electron as { dialog?: DialogModule }).dialog;
if (electronDialog) {
  try {
    const origOpen = electronDialog.showOpenDialog.bind(electronDialog);
    const origSave = electronDialog.showSaveDialog.bind(electronDialog);
    // 域层传 (window, options) 或 (options)：统一剥出 options 再调原生（不依赖隐藏窗口）
    const optsOf = (a: unknown[]) => (a.length >= 2 ? a[1] : a[0]);
    const wrapOpen = (...a: unknown[]) => {
      const next = dialogAnswers.shift();
      if (next) { console.log(`[headless] 对话框桥：消费预置答案 ${JSON.stringify(next.filePaths)}`); return Promise.resolve(next); }
      if (DIALOG_MODE === "native") return origOpen(optsOf(a) as never);
      console.log("[headless] 对话框桥：cancel 模式无预置答案 → canceled");
      return Promise.resolve({ canceled: true, filePaths: [] });
    };
    const wrapSave = (...a: unknown[]) => {
      const next = dialogAnswers.shift();
      if (next) return Promise.resolve({ canceled: false, filePath: next.filePaths[0] });
      if (DIALOG_MODE === "native") return origSave(optsOf(a) as never);
      return Promise.resolve({ canceled: true, filePath: undefined });
    };
    // ⛔ electron 模块方法一般可赋值（ipcMain.handle 同例）；defineProperty 兜一层。
    try { electronDialog.showOpenDialog = wrapOpen; electronDialog.showSaveDialog = wrapSave; }
    catch {
      Object.defineProperty(electronDialog, "showOpenDialog", { value: wrapOpen, configurable: true });
      Object.defineProperty(electronDialog, "showSaveDialog", { value: wrapSave, configurable: true });
    }
    // 自证接线：包装真的挂上去了（防止「赋值被静默忽略」的自洽假绿）
    if (electronDialog.showOpenDialog !== wrapOpen) console.error("[headless] ⛔ 对话框包装未生效——原生弹窗将挂起，请检查 electron.dialog 可写性");
  } catch (error) { console.error("[headless] 对话框桥初始化失败：", error); }
} else {
  console.error("[headless] ⛔ electron.dialog 不可用，对话框桥未接线");
}

/* ── ②c 云版配对与鉴权（与伴生服务同语义、同落盘）──────────────────────────
   home = HARNESS_CLOUD_HOME（默认 ~/.codex-harness-cloud），token/users.json 与
   伴生服务**共用** ⇒ --add-user 签发的个人码两边通用。四道闸与 local-agent/auth.js
   同源：Bearer（不用 Cookie）/ Origin 白名单 / 预检强制 / 常量时间比较。桥的全部
   状态通道（/__ipc /__events /__upload /__dialog）都要过 token；/api/health、
   /api/pair 与静态资产除外 —— 配对就是为了换 token。 */
const CHC_HOME = process.env.HARNESS_CLOUD_HOME || join(homedir(), ".codex-harness-cloud");
type ChcUser = { name: string; code: string; token: string; createdAt: number };
function loadChcUsers(): ChcUser[] {
  try {
    const parsed = JSON.parse(readFileSync(join(CHC_HOME, "users.json"), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ChcUser[]) : [];
  } catch { return []; }
}
function persistChcUsers(users: ChcUser[]): void {
  mkdirSync(CHC_HOME, { recursive: true });
  writeFileSync(join(CHC_HOME, "users.json"), JSON.stringify(users, null, 2), { mode: 0o600 });
}
const chcTokenFile = join(CHC_HOME, "token");
let ownerToken = "";
try { ownerToken = readFileSync(chcTokenFile, "utf8").trim(); } catch { /* 首次运行 */ }
if (!ownerToken) {
  ownerToken = randomBytes(32).toString("hex");
  mkdirSync(CHC_HOME, { recursive: true });
  writeFileSync(chcTokenFile, ownerToken, { mode: 0o600 });
}
function safeEq(a: string, b: string): boolean {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
function whoByToken(presented: string, users: ChcUser[]): string | null {
  if (presented && safeEq(presented, ownerToken)) return "owner";
  for (const user of users) if (safeEq(presented, user.token)) return user.name;
  return null;
}
/* ⛔ --add-user 必须在起服务 / 进 main 之前处理：签发完就退出，不占端口。 */
const addUserIndex = process.argv.indexOf("--add-user");
if (addUserIndex >= 0) {
  const name = String(process.argv[addUserIndex + 1] || "").trim();
  try {
    if (!name) throw new Error("用户名不能为空");
    const users = loadChcUsers();
    if (users.some((u) => u.name === name)) throw new Error(`用户「${name}」已存在`);
    const user: ChcUser = { name, code: randomBytes(4).toString("hex"), token: randomBytes(24).toString("hex"), createdAt: Date.now() };
    users.push(user);
    persistChcUsers(users);
    process.stdout.write(`\n  用户「${user.name}」的配对码：${user.code}\n  （唯一一次显示，请交给本人；token 已落盘）\n\n`);
  } catch (error) {
    process.stderr.write(`[add-user] ${(error as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}
const allowedOrigins = (() => {
  const list = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, "https://ppz123.asia", "https://www.ppz123.asia"];
  try {
    const saved = JSON.parse(readFileSync(join(CHC_HOME, "config.json"), "utf8")) as { allowedOrigins?: unknown };
    if (Array.isArray(saved.allowedOrigins)) {
      for (const entry of saved.allowedOrigins) if (typeof entry === "string" && !list.includes(entry)) list.push(entry);
    }
  } catch { /* 没有伴生配置就只放本机 + 站点 */ }
  return list;
})();
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;   // 无 Origin = 非浏览器发起（curl / 服务自测）
  return allowedOrigins.includes(origin);
}
function corsFor(origin: string | undefined): Record<string, string> {
  if (!origin || !originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-harness-client",
    // ⛔ 云端页面连本机回环时 Chrome 发私有网络预检，缺这个头会被拦（auth.js 同款）
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
function tokenOf(req: IncomingMessage, url: URL): string {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(url.searchParams.get("t") || "");
}
function bridgeAuthOk(req: IncomingMessage, url: URL): boolean {
  if (!originAllowed(req.headers.origin)) return false;
  return Boolean(whoByToken(tokenOf(req, url), loadChcUsers()));
}
const PAIR_MAX_TRIES = 10;
const PAIR_LOCK_MS = 60_000;
let pairTries = 0;
let pairLockedUntil = 0;

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
  function tok() { try { return localStorage.getItem("chc-token") || ""; } catch (e) { return ""; } }
  function authHeaders(extra) {
    var h = extra || {};
    var t = tok();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  function showPairBox() {
    if (document.getElementById("__chc-pair")) return;
    var box = document.createElement("div");
    box.id = "__chc-pair";
    box.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999";
    var card = document.createElement("div");
    card.style.cssText = "background:#fff;color:#222;border-radius:12px;padding:28px 32px;max-width:360px;width:90%;font-family:system-ui,sans-serif;text-align:center";
    var head = document.createElement("div"); head.textContent = "连接这台电脑的助手";
    head.style.cssText = "font-size:15px;font-weight:600;margin-bottom:6px";
    var tip = document.createElement("div");
    tip.textContent = "输入个人配对码（助手控制台 --add-user 名字 签发）；或在 ppz123.asia 登录后连接。";
    tip.style.cssText = "font-size:12.5px;color:#666;line-height:1.6;margin-bottom:12px";
    var input = document.createElement("input");
    input.placeholder = "8 位配对码"; input.maxLength = 8; input.autocomplete = "off";
    input.style.cssText = "width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;letter-spacing:4px;text-align:center;border:1px solid #ccc;border-radius:8px;margin-bottom:10px";
    var btn = document.createElement("button"); btn.textContent = "连接";
    btn.style.cssText = "width:100%;padding:9px 0;background:#185fa5;color:#fff;border:none;border-radius:8px;font-size:13.5px;cursor:pointer";
    var st = document.createElement("div"); st.style.cssText = "font-size:12px;color:#a32d2d;margin-top:8px;min-height:16px";
    btn.onclick = function () {
      var code = (input.value || "").trim().toLowerCase();
      if (!code) { st.textContent = "请输入配对码"; return; }
      btn.disabled = true; st.style.color = "#666"; st.textContent = "正在连接…";
      fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json", "x-harness-client": "web" }, body: JSON.stringify({ code: code }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) {
            st.textContent = j && j.error === "mismatch" ? "配对码不对" : j && j.error === "locked" ? "尝试过多，锁定 1 分钟" : "失败：" + ((j && j.error) || "未知");
            st.style.color = "#a32d2d"; btn.disabled = false; return;
          }
          try { localStorage.setItem("chc-token", j.token); } catch (e) { /* 忽略 */ }
          location.reload();
        })
        .catch(function () { st.textContent = "网络错误"; btn.disabled = false; });
    };
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") btn.click(); });
    card.appendChild(head); card.appendChild(tip); card.appendChild(input); card.appendChild(btn); card.appendChild(st);
    box.appendChild(card); document.body.appendChild(box);
    input.focus();
  }
  function connect() {
    var es = new EventSource("/__events?t=" + encodeURIComponent(tok()));
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
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: id, channel: channel, args: args }),
      }).then(function (r) {
        if (r.status === 401) { showPairBox(); throw new Error("未配对（401）"); }
        return r.json();
      }).then(function (body) {
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
  /* ⛔ 选图/选文件直走真通道：main 侧弹**原生对话框**到用户屏幕（助手在本机），
     返回绝对路径，与桌面版完全同形（无大小限制）。/__upload 仍保留作远程后备。 */
  codex.chooseImages = function () { return invoke("dialog:images", []); };
  codex.chooseFiles = function () { return invoke("dialog:files", []); };
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
  /* ⛔ 目录选择直走真通道：main 侧弹原生对话框到用户屏幕（助手在本机），
     trustPicked 登记可信根等真实语义照常执行。取消返回 null，与桌面版同形。 */
  function pickDirectory(startPath, useAt) {
    return invoke(useAt ? "dialog:directory-at" : "dialog:directory", useAt ? [startPath] : [])
      .then(function (path) { return path == null ? null : path; })
      .catch(function (e) { console.error("[shim] chooseDirectory", e); return null; });
  }
  codex.chooseDirectory = function () { return pickDirectory("", false); };
  codex.chooseDirectoryAt = function (startPath) { return pickDirectory(startPath || "", true); };

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
  // 云端登录门的 token 交接：/#t=<token>（fragment 不进服务器日志）→ localStorage → 抹掉 hash
  const handoff = `<script>(function(){var m=/^t=([0-9a-f]{16,})$/.exec(location.hash.slice(1));if(m){try{localStorage.setItem("chc-token",m[1])}catch(e){}history.replaceState(null,"",location.pathname+location.search)}})();</script>\n`;
  return rewritten.replace("</head>", `${cdnMark}${handoff}<script>${shimJs}</script>\n</head>`);
}

function route(req: IncomingMessage, res: ServerResponse, shimJs: string) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const p = url.pathname;
  const origin = req.headers.origin;

  // CORS 预检：只放行白名单 Origin（第三方页面连不上本机回环的第一道闸）
  if (req.method === "OPTIONS") {
    const headers = corsFor(origin);
    if (!headers["Access-Control-Allow-Origin"]) { res.writeHead(403).end(); return; }
    res.writeHead(204, headers).end();
    return;
  }
  const cors = corsFor(origin);
  const deny = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors }).end(JSON.stringify(body));
  };

  // 云版门面（登录门探测 + 配对换 token；协议与伴生服务一致 ⇒ 门零改动可用）
  if (p === "/api/health") {
    deny(200, { ok: true, product: "codex-harness-cloud", protocolVersion: 1, mode: "real-ui" });
    return;
  }
  if (p === "/api/pair" && req.method === "POST") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      let code = "";
      try { code = String((JSON.parse(raw) as { code?: unknown }).code || "").trim().toLowerCase(); } catch { deny(400, { ok: false, error: "bad-json" }); return; }
      if (Date.now() < pairLockedUntil) { deny(403, { ok: false, error: "locked" }); return; }
      pairTries += 1;
      if (pairTries >= PAIR_MAX_TRIES) { pairLockedUntil = Date.now() + PAIR_LOCK_MS; pairTries = 0; console.log("[pair] 用户码连续错误过多，锁定 60 秒"); deny(403, { ok: false, error: "locked" }); return; }
      const hit = loadChcUsers().find((user) => safeEq(code, user.code));
      if (!hit) { deny(403, { ok: false, error: "mismatch" }); return; }
      pairTries = 0;
      console.log(`[pair] 用户「${hit.name}」配对成功（真界面助手）`);
      deny(200, { ok: true, token: hit.token, account: { userId: hit.name, name: hit.name }, protocolVersion: 1 });
    });
    return;
  }

  // ⛔ /__* 状态通道逐一上 token 闸（静态外壳不挡 —— 它要自己消费 #t / 弹配对框）

  // ⛔ 传图通道（用户定调：限 2M）。浏览器 <input type=file> → 这里落盘 →
  //   返回本地路径，渲染层/引擎拿到的与桌面版选图**同形**（都是本地路径）。
  if (p === "/__upload" && req.method === "POST") {
    if (!bridgeAuthOk(req, url)) { deny(401, { ok: false, error: "unauthorized" }); return; }
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

  // ⛔ 对话框桥（浏览器点不到原生弹窗）：预置答案进队列，main 侧 showOpenDialog/
  //   showSaveDialog 消费队首。paths 数组 = 一次多选；空队列时对话框按「取消」处理。
  if (p === "/__dialog" && req.method === "POST") {
    if (!bridgeAuthOk(req, url)) { deny(401, { ok: false, error: "unauthorized" }); return; }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { paths?: unknown };
        const paths = Array.isArray(body.paths) ? body.paths.map((x) => String(x)).filter(Boolean) : [];
        if (!paths.length) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "paths 不能为空" }));
          return;
        }
        dialogAnswers.push({ canceled: false, filePaths: paths });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, queued: dialogAnswers.length }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad json" }));
      }
    });
    return;
  }
  if (p === "/__dialog" && req.method === "GET") {
    if (!bridgeAuthOk(req, url)) { deny(401, { ok: false, error: "unauthorized" }); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, queued: dialogAnswers.length }));
    return;
  }

  if (p === "/__events") {
    if (!bridgeAuthOk(req, url)) { deny(401, { ok: false, error: "unauthorized" }); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ event: "__hello", payload: { at: Date.now() } })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (p === "/__ipc" && req.method === "POST") {
    if (!bridgeAuthOk(req, url)) { deny(401, { ok: false, error: "unauthorized" }); return; }
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

/* ── ⑥ 独立窗口的无头形态：弹到用户的浏览器 ───────────────────────────────
   桌面版「独立窗口」= 新开一个 Electron 窗口；无头下窗口永远隐藏，浏览器用户
   什么都看不到（实测 bug）。改为：真实通道照常执行（保留 popout 登记/事件路由），
   然后**在用户默认浏览器里弹独立标签页** http://127.0.0.1:8917/?popout=<threadId>
   —— 同一套 dist + 同一份 shim，浏览器标签页就是无头版的"独立窗口"。
   ⛔ 必须在 require("./main") 之后包（handler 由域模块注册）。 */
import { spawn as nodeSpawn } from "node:child_process";
const popoutHandler = invokeHandlers.get("window:popout-thread");
if (popoutHandler) {
  invokeHandlers.set("window:popout-thread", async (event, ...args) => {
    const result = await popoutHandler(event, ...args);
    const threadId = String(args[0] ?? "");
    try {
      const url = `http://127.0.0.1:${PORT}/?popout=${encodeURIComponent(threadId)}`;
      // ⛔ mac 适配：cmd /c start 是 Windows 专属；darwin 用 open，其余 xdg-open
      const openCmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      nodeSpawn(openCmd, openArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
      console.log(`[headless] 独立窗口 → 浏览器标签页 ${url}`);
    } catch (error) { console.error("[headless] 弹浏览器独立窗口失败：", error); }
    return result;
  });
} else {
  console.error("[headless] ⛔ window:popout-thread 无 handler，独立窗口桥未接线");
}
