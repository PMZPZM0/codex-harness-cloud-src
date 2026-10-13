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
import { app, ipcMain, shell } from "electron";
import { mutableState } from "./main";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { openInBrowser, assistantUrl } from "./open-browser";
import { getAssistantWindow, isAssistantWindowPending, showAssistantWindow } from "./assistant-window";

// ⛔ 本机 GPU 进程必崩（exit_code=-1073741819），崩 9 次后整个进程 FATAL 退出 ——
//   与走查台同一配方，必须在 app 就绪**之前**挂上。
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

/* ⛔ 助手运行时标记（10-11）：更新源按产品线分开——助手只认 `cloud-v*` tag 与
 *   `CodexHarnessAssistant-*` 资产，绝不跟桌面版的 `v*` 串（同一仓库两条产品线）。
 *   必须在 require("./main") 之前打：域模块加载时就会读它。 */
process.env.HARNESS_ASSISTANT = "1";

/* ⛔⛔ 与桌面版**彻底拆开**（10-12 用户：「全部拆开——禁止共享数据目录和安装目录」）
 *   事故根因：助手包内 package.json 的 name/productName 与桌面版相同 ⇒
 *     ① 同一个 userData（`%APPDATA%/codex-harness-desktop`）⇒ **同一个单实例锁**：
 *        两者不能同时运行，后启动的静默退出（"幽灵应用"）；
 *     ② AUMID 相同（main.ts 写死 com.codexharness.desktop）⇒ **任务栏分组与托盘图标身份相同**，
 *        互相顶掉（"任务栏没有、托盘也没有"）。
 *   ⇒ 在 require("./main") 之前钉死独立数据目录（走 resolveStartupUserData 的 env 分支，
 *     与 data-dir.ts 的优先级一致）与独立 AUMID。安装目录的隔离在打包侧
 *     （electron-builder.assistant.yml 的 extraMetadata.name + nsis.installDirectoryName）。 */
if (!process.env.CODEX_HARNESS_USER_DATA) {
  process.env.CODEX_HARNESS_USER_DATA = join(app.getPath("appData"), "codex-assistant");
}
try { app.setAppUserModelId("com.codexharness.assistant"); } catch { /* 非 win 平台忽略 */ }

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
   每个窗口创建时包一层 webContents.send（全部主→渲染事件由此广播给浏览器 SSE）。

   10-12 用户定调（"配对走浏览器一次就行，后面要像正常应用一样启动"）：
   助手**自己管一个可见主窗口**（加载 http://127.0.0.1:PORT/，含 shim ⇒ 配对框就在窗口里），
   桌面版 window-factory 的主窗 / 宠物 / 弹出 / 截图遮罩**仍旧隐藏 + 摘任务栏 + 短路 show**。
   区分办法：创建助手窗前置 `pendingAssistantWindow` 旗（browser-window-created 在
   `new BrowserWindow()` 内**同步**触发，晚于构造返回，所以必须用旗而不是事后比对）。 */

app.on("browser-window-created", (_event: unknown, win: { hide: () => void; setSkipTaskbar: (v: boolean) => void; show: () => void; showInactive: () => void; maximize: () => void; restore: () => void; focus: () => void; webContents: { send: (channel: string, ...args: unknown[]) => void } }) => {
  if (isAssistantWindowPending()) {
    // 助手主窗口：保持可见与任务栏，只包事件广播（与隐藏窗口同一套广播，别处不套）
    try {
      const wc = win.webContents;
      const origSend = wc.send.bind(wc);
      wc.send = (channel: string, ...args: unknown[]) => {
        broadcast({ event: channel, payload: args.length <= 1 ? args[0] : args });
        return origSend(channel, ...args);
      };
    } catch { /* 忽略 */ }
    return;
  }
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
    // 域层传 (window, options) 或 (options)：统一剥出 options。
    // ⛔⛔ 父窗口必须换成**助手自己的可见窗口**（10-12 用户报「云助手没有本地项目地址」）：
    //   域层传进来的 mainWindow 在助手形态下是 null（助手不再创建桌面版主窗），而此前几版
    //   那个被藏起来的主窗当父窗口时，Windows 会把模态对话框一起"藏"掉 ⇒ 点「选择项目地址」
    //   什么都不弹。改成挂到 assistant-window 上（可见窗口）⇒ 对话框正常出现在窗口前面。
    const optsOf = (a: unknown[]) => (a.length >= 2 ? a[1] : a[0]);
    const parentOf = () => {
      const w = getAssistantWindow();
      return w ? (w as unknown as never) : null;
    };
    const callOpen = (opts: unknown) => {
      const parent = parentOf();
      return parent ? origOpen(parent, opts as never) : origOpen(opts as never);
    };
    const callSave = (opts: unknown) => {
      const parent = parentOf();
      return parent ? origSave(parent, opts as never) : origSave(opts as never);
    };
    const wrapOpen = (...a: unknown[]) => {
      const next = dialogAnswers.shift();
      if (next) { console.log(`[headless] 对话框桥：消费预置答案 ${JSON.stringify(next.filePaths)}`); return Promise.resolve(next); }
      if (DIALOG_MODE === "native") return callOpen(optsOf(a));
      console.log("[headless] 对话框桥：cancel 模式无预置答案 → canceled");
      return Promise.resolve({ canceled: true, filePaths: [] });
    };
    const wrapSave = (...a: unknown[]) => {
      const next = dialogAnswers.shift();
      if (next) return Promise.resolve({ canceled: false, filePath: next.filePaths[0] });
      if (DIALOG_MODE === "native") return callSave(optsOf(a));
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
/* ── 账号闸（10-13）：**配对必须先有网页账号** ────────────────────────────────
   与 cloud/local-agent 的账号闸同一套语义（见其 auth.js / server.js 头注），但**两份实现并存**
   （这里 = Electron 真界面，那里 = 伴生服务 Node 脚本）—— 落盘**共用**同一批文件
   （token / users.json / accounts.json 都在 HARNESS_CLOUD_HOME），所以两边必须同口径。
   ⛔⛔ **默认必须与伴生服务一致（云端）**：这里曾只读环境变量、没给默认 ⇒ 用户平时双击启动
   （不带任何环境变量）时闸**永远是关的**，而伴生服务那条路却是开的 —— 同一台机器两种口径。
   解析顺序：env > config.json 的 accountsBase > 默认云端；空串 = 独立模式（显式选择）。 */
const DEFAULT_ACCOUNTS_BASE = "https://ppz123.asia/cloud-api";
const ACCOUNTS_BASE = (() => {
  const fromEnv = process.env.HARNESS_ACCOUNTS_URL;
  if (fromEnv !== undefined) return String(fromEnv).replace(/\/+$/, "");
  try {
    const saved = JSON.parse(readFileSync(join(CHC_HOME, "config.json"), "utf8")) as { accountsBase?: unknown };
    if (typeof saved.accountsBase === "string") return saved.accountsBase.replace(/\/+$/, "");
  } catch { /* 没有配置文件就走默认 */ }
  return DEFAULT_ACCOUNTS_BASE;
})();
/** 网页登录门（用户在这里注册并配对）。开闸时本机界面只负责把人送到这里。 */
const ASSISTANT_WEB_ENTRY = "https://ppz123.asia/cloud/";
const GATED = ACCOUNTS_BASE.length > 0;
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
const chcTokenFile = join(CHC_HOME, "token");let ownerToken = "";
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
  /* ⛔ 开闸时：一个"座位"必须绑定了网页账号才算有效 ——
     账号被停用 ⇒ 绑定被摘 ⇒ 它所有令牌立刻失效（旧缺口：停用只管新配对）。 */
  let seat: string | null = null;
  if (presented && safeEq(presented, ownerToken)) seat = "owner";
  else {
    const hit = users.find((user) => safeEq(presented, user.token));
    if (hit) seat = hit.name;
  }
  if (!seat) return null;
  if (GATED && !accountOf(seat)) return null;
  return seat;
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
    process.stdout.write(`\n  用户「${user.name}」的配对码：${user.code}\n  （唯一一次显示，请交给本人；token 已落盘）\n`);
    process.stdout.write(process.env.HARNESS_ACCOUNTS_URL
      ? `  ⛔ 开闸模式：本人还须先在网页注册账号，再用这个码配对：\n     ${ASSISTANT_WEB_ENTRY}\n\n`
      : `  ⚠️ 独立模式（没配账号服务）：这个码直接配对即可，无需网页账号。\n\n`);
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
// 界面内一键签发（/api/issue-code）的限流：60 秒窗口内最多 3 次
const ISSUE_MAX = 3;
const ISSUE_WINDOW_MS = 60_000;
let issueWindow = 0;
let issueLockedUntil = 0;
let pairTries = 0;
let pairLockedUntil = 0;

/* 账号闸的实现（配置见上方 ACCOUNTS_BASE / GATED / ASSISTANT_WEB_ENTRY）：
   · 配对成功 ⇒ 座位绑定账号（accounts.json，与伴生服务**同一份文件同一格式**）；
   · 账号被停用 ⇒ 绑定被摘 ⇒ 令牌立刻失效（轮询，**失败放行**）。 */
const ACCOUNT_POLL_MS = Math.max(500, Number(process.env.HARNESS_ACCOUNT_POLL_MS || 5 * 60_000));

/* owner 一次性开机码（与 cloud/local-agent 的 Pairing 同口径：5 分钟 / 一次性 / 只打控制台）。
   ⛔⛔ headless 之前**没有**这条 —— 它的码只能靠 `--add-user` 或界面内一键签发；
     接入账号闸后，网页配对需要一张"这台机器"的码可填，第一条个人码都没法配 ⇒ 必须补上。
   「配对码只打在控制台：能看到这行输出的人，才配得上这台机器」——信任模型不变。 */
const OWNER_PAIR_TTL_MS = 5 * 60_000;
let ownerPairCode = "";
let ownerPairIssuedAt = 0;
/* ⛔⛔ 10-13 晚：**本机码在未认领前必须稳定不变**。
   旧逻辑 5 分钟轮换 —— 用户切去网页注册的工夫码就换了：卡片上看到的码作废、
   本机轮询的码与网页认领的码对不上，整条认领链断在半路（用户实测："注册好了返回都没有"）。
   新语义：**启动时发一枚，认领成功（redeem）或用户手动重生成之前一直有效**。
   暴力面由既有闸兜住：/api/pair 10 次锁 60 秒 + claim-status 限速 + 8 位十六进制空间。 */
function issueOwnerPair(): string {
  if (!ownerPairCode) {
    ownerPairCode = randomBytes(4).toString("hex");
    ownerPairIssuedAt = Date.now();
  }
  return ownerPairCode;
}
/** 唤起系统浏览器打开授权页（主进程直开 —— 不依赖渲染层桥；自动与卡片按钮都走这里）。 */
function openAuthPage(): void {
  const url = ASSISTANT_WEB_ENTRY + "?claim=" + issueOwnerPair();
  try { shell.openExternal(url); console.log("[device] 已唤起系统浏览器打开授权页：" + url); }
  catch (error) { console.error("[device] 唤起浏览器失败：", error); }
}
let authAutoOpened = false;
function redeemOwnerPair(candidate: string): { ok: boolean; reason?: string } {
  if (!ownerPairCode) return { ok: false, reason: "no-code" };
  if (!safeEq(candidate, ownerPairCode)) return { ok: false, reason: "mismatch" };
  ownerPairCode = "";   // 一次性：成功即作废，重放无效
  return { ok: true };
}
function printOwnerPairBanner(): void {
  const code = issueOwnerPair();
  console.log(`\n  ┌───────────────────────────────────────────────┐`);
  console.log(`  │  本机配对码： ${code}   （认领成功前一直有效；已绑账号后作废）`);
  console.log(GATED
    ? `  │  ⛔ 需先在网页注册账号，再用这个码完成配对：\n  │     ${ASSISTANT_WEB_ENTRY}`
    : `  │  ⚠️ 独立模式（没配账号服务）：本机界面直接填这个码即可`);
  console.log(`  └───────────────────────────────────────────────┘\n`);
}
type AccountBindingFile = { owner: string; users: Record<string, string> };
function loadAccountBindings(): AccountBindingFile {
  try {
    const parsed = JSON.parse(readFileSync(join(CHC_HOME, "accounts.json"), "utf8")) as Partial<AccountBindingFile>;
    return {
      owner: String(parsed.owner || ""),
      users: parsed.users && typeof parsed.users === "object" ? parsed.users : {},
    };
  } catch { return { owner: "", users: {} }; }
}
function persistAccountBindings(bindings: AccountBindingFile): void {
  mkdirSync(CHC_HOME, { recursive: true });
  writeFileSync(join(CHC_HOME, "accounts.json"), JSON.stringify(bindings, null, 2), { mode: 0o600 });
}
function bindSeat(seat: string, username: string): void {
  const name = String(username || "").trim();
  if (!seat || !name) return;
  const bindings = loadAccountBindings();
  if (seat === "owner") bindings.owner = name; else bindings.users[seat] = name;
  persistAccountBindings(bindings);
}
function accountOf(seat: string): string {
  const bindings = loadAccountBindings();
  return seat === "owner" ? bindings.owner : bindings.users[seat] || "";
}
function unbindByAccount(username: string): boolean {
  const bindings = loadAccountBindings();
  let hit = false;
  if (username && bindings.owner === username) { bindings.owner = ""; hit = true; }
  for (const [seat, bound] of Object.entries(bindings.users)) {
    if (bound === username) { delete bindings.users[seat]; hit = true; }
  }
  if (hit) persistAccountBindings(bindings);
  return hit;
}
function boundAccounts(): string[] {
  const bindings = loadAccountBindings();
  return [...new Set([bindings.owner, ...Object.values(bindings.users)].filter(Boolean))];
}
/** 向账号服务核销票据。⛔ 由本机发起 —— 网页说的登录态不算数。失败**分档**返回。 */
async function verifyAccountTicket(ticket: string): Promise<{ ok: boolean; username?: string; reason?: string }> {
  try {
    const response = await fetch(`${ACCOUNTS_BASE}/pair-ticket/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(8000),
    });
    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; username?: unknown; reason?: unknown };
    if (!response.ok) return { ok: false, reason: response.status === 429 ? "rate-limited" : "accounts-unreachable" };
    if (payload && payload.ok && payload.username) return { ok: true, username: String(payload.username) };
    return { ok: false, reason: String(payload.reason || "unknown") };
  } catch (error) {
    console.error(`[account] 账号服务不可达：${(error as Error).message}`);
    return { ok: false, reason: "accounts-unreachable" };
  }
}
/** 停用轮询（失败放行：账号服务不可达时**不摘绑定**，否则服务一抖所有人当场掉线）。 */
async function pollAccountStatus(): Promise<void> {
  if (!GATED) return;
  const accounts = boundAccounts();
  if (!accounts.length) return;
  try {
    const response = await fetch(`${ACCOUNTS_BASE}/pair-ticket/status?usernames=${encodeURIComponent(accounts.join(","))}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    cloudReachable = true;
    const payload = (await response.json().catch(() => null)) as { accounts?: Record<string, { disabled?: boolean }> } | null;
    for (const [username, info] of Object.entries(payload?.accounts || {})) {
      if (info?.disabled && unbindByAccount(username)) {
        console.log(`[account] 账号「${username}」已停用或不存在 ⇒ 摘除绑定，其令牌立即失效`);
      }
    }
  } catch { /* 不可达 = 保持现状（失败放行） */ }
}

/* ── 设备入网轮询（10-13 二期）：本机码 → 云端匹配 → 拿设备 token ───────────
   流程：本机打印配对码 → 用户在网页注册/登录后**认领**这个码 → 服务端绑定
   「账号 ⟷ 本机码」→ 本机轮询拿到**设备 token**（HMAC 派生）→ 落盘（0600）。
   ⛔ 这就是"允许本地连接服务器"的那把钥匙：此后检查更新/将来的云端会话索引都凭它。
   ⛔ 只有还没绑定任何账号时才轮询（已配对就别再打服务器）。 */
const deviceTokenFile = join(CHC_HOME, "device-token");
function saveDeviceToken(token: string): void {
  mkdirSync(CHC_HOME, { recursive: true });
  writeFileSync(deviceTokenFile, token, { mode: 0o600 });
}
export function readDeviceToken(): string {
  try { return readFileSync(deviceTokenFile, "utf8").trim(); } catch { return ""; }
}
/** 账号服务可达性（云端管理面板展示用；由两个轮询顺手维护）。 */
let cloudReachable = false;
async function pollDeviceClaim(): Promise<void> {
  if (!GATED) return;
  if (boundAccounts().length > 0) return;                       // 已配对：不再轮询
  const code = ownerPairCode;
  if (!code) return;                                            // 本机码还没生成
  try {
    const response = await fetch(`${ACCOUNTS_BASE}/device/claim-status?code=${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    cloudReachable = true;
    const payload = (await response.json().catch(() => null)) as { claimed?: boolean; token?: unknown; username?: unknown } | null;
    if (!payload?.claimed || typeof payload.token !== "string" || !payload.token) return;   // 还没人认领，继续等
    const username = String(payload.username || "");
    bindSeat("owner", username);
    saveDeviceToken(payload.token);
    console.log(`[device] 本机已被网页账号「${username}」认领 ⇒ 设备 token 已落盘，允许连接服务器`);
    // ⛔ 给已打开的助手窗口**注入本地令牌**并刷新 —— 同进程 ⇒ 直接写 localStorage 即可，
    //    用户全程无感：网页认领后，本机窗口自己进入界面（不需要再输码 / 走票据）。
    try {
      const win = getAssistantWindow();
      if (win && !win.isDestroyed()) {
        // AssistantWin 是窄接口（show/focus/hide…）⇒ webContents 走结构化断言
        const wc = (win as unknown as { webContents: { executeJavaScript: (code: string) => Promise<unknown>; reload: () => void } }).webContents;
        void wc
          .executeJavaScript(`try{localStorage.setItem("chc-token", ${JSON.stringify(ownerToken)})}catch(e){}`)
          .then(() => {
            wc.reload();
            console.log("[device] 助手窗口已注入本地令牌并刷新（自动进入界面）");
          })
          .catch(() => undefined);
      }
    } catch { /* 窗口不在就随它去：用户刷新本机页面即可 */ }
  } catch { /* 账号服务不可达：下轮再试 */ }
}

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

function buildShim(manifest: { channels: ManifestEntry[] }, onChannels: OnEntry[], accountGate: boolean): string {
  /* ⛔ 账号闸开关必须**由服务端注入**：shim 跑在浏览器里，自己猜不出（它连配置文件都读不到）。
     界面的配对卡据此决定"收配对码"还是"指去网页"—— 两个方向必须与主进程一致。
     ⛔ 同理：网页入口与本机配对码也要注入 —— 配对卡跑在浏览器里，
        引用主进程常量会直接 ReferenceError（卡片整个画不出来，实测踩过）。 */
  const gateInject = `window.__CHC_ACCOUNT_GATE__ = ${accountGate ? "true" : "false"};\n`
    + `window.__CHC_WEB_ENTRY__ = ${JSON.stringify(ASSISTANT_WEB_ENTRY)};\n`
    + `window.__CHC_PAIR_CODE__ = ${JSON.stringify(issueOwnerPair())};\n`;
  return `/* 自动生成（electron/headless.ts）—— 浏览器端 window.codex，与桌面 preload 同源同形 */
(function () {
  "use strict";
  ${gateInject}  var listeners = {};           // channel → Set<listener>
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
  var brandObserver = null;
  function watchAssistantBrand() {
    applyAssistantBrand();
    if (brandObserver || typeof MutationObserver === "undefined") return;
    brandObserver = new MutationObserver(function () { applyAssistantBrand(); });
    brandObserver.observe(document.body, { childList: true, subtree: true });
  }

  function connect() {
    var es = new EventSource("/__events?t=" + encodeURIComponent(tok()));
    es.onmessage = function (m) { try { emit(JSON.parse(m.data)); } catch (e) { /* 忽略坏帧 */ } };
    es.onerror = function () { es.close(); setTimeout(connect, 1200); };   // 断线重连
  }
  connect();

  /* ⛔⛔ 未配对 ⇒ 整个外壳重定向到独立配对页 /pair（10-14 用户令「没匹配应用不加载」）：
     应用一行代码都不加载 —— 没有启动图、没有动画、不发任何请求（自然没有 401 噪音）。
     ⛔ 这段内联在 </head> 前 ⇒ 早于 body 里的模块脚本执行；配对页同源，
        配对完成后自己写 localStorage 并跳回 /，闸自然放行。
     ⛔⛔ 本注释内**禁写反引号**：会把外层模板字面量提前终结（实测编译错误）。 */
  if (!tok()) {
    location.replace("/pair");
  }
  function onReady() {
    watchAssistantBrand();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }

  function invoke(channel, args) {
    return new Promise(function (resolve, reject) {
      var id = String(nextId++);
      pending[id] = { resolve: resolve, reject: reject };
      fetch("/__ipc", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: id, channel: channel, args: args }),
      }).then(function (r) {
        if (r.status === 401) { location.replace("/pair"); throw new Error("未配对（401）"); }
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

/* 二次启动（用户再点一次快捷方式）⇒ **带出助手窗口**（10-13 用户："关闭应用没有办法重启应用"）：
   main.ts 的 second-instance 只调 showMainWindow() —— 无头形态下主窗口是隐藏的，
   用户看到的是"什么都没发生"，真正的界面在助手窗口里 ⇒ 这里补一个把助手窗口带起来的。
   （双击快捷方式 = 唤回界面；真正退出走托盘右键「退出"。） */
app.on("second-instance", () => { void showAssistantWindow(); });

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
    req.on("end", async () => {
      let code = "";
      let ticket = "";
      try {
        const parsed = JSON.parse(raw) as { code?: unknown; ticket?: unknown };
        code = String(parsed.code || "").trim().toLowerCase();
        ticket = String(parsed.ticket || "").trim();
      } catch { deny(400, { ok: false, error: "bad-json" }); return; }

      /* ⛔⛔ 开闸时**先核销票据、再比码**（与 cloud/local-agent 同口径）：
         票据不过就直接拒，**不进入码比对** —— 免得拿错误信息探测本机码是否存在；
         核销由**本机**向账号服务发起，不信网页转述的登录态。 */
      let account = "";
      if (GATED) {
        if (!ticket) { deny(403, { ok: false, error: "ticket-required" }); return; }
        const verified = await verifyAccountTicket(ticket);
        if (!verified.ok) { deny(403, { ok: false, error: `ticket-${verified.reason}` }); return; }
        account = verified.username || "";
      }

      /* owner 一次性开机码优先（seat=owner，绑到配对者的账号）；然后才是 --add-user 的个人码。 */
      const ownerPair = redeemOwnerPair(code);
      if (ownerPair.ok) {
        pairTries = 0;
        bindSeat("owner", account);
        console.log(`[pair] owner 配对成功（真界面助手${account ? ` · 账号 ${account}` : ""}）`);
        deny(200, { ok: true, token: ownerToken, account: { userId: account || "owner", name: account || "owner", seat: "owner" }, protocolVersion: 1 });
        return;
      }

      if (Date.now() < pairLockedUntil) { deny(403, { ok: false, error: "locked" }); return; }
      pairTries += 1;
      if (pairTries >= PAIR_MAX_TRIES) { pairLockedUntil = Date.now() + PAIR_LOCK_MS; pairTries = 0; console.log("[pair] 用户码连续错误过多，锁定 60 秒"); deny(403, { ok: false, error: "locked" }); return; }
      const hit = loadChcUsers().find((user) => safeEq(code, user.code));
      if (!hit) { deny(403, { ok: false, error: "mismatch" }); return; }
      pairTries = 0;
      // 配对成功 ⇒ 座位绑定到账号（对外身份从此是账号 username，不再是本机名字）
      bindSeat(hit.name, account);
      console.log(`[pair] 用户「${hit.name}」配对成功（真界面助手${account ? ` · 账号 ${account}` : ""}）`);
      deny(200, { ok: true, token: hit.token, account: { userId: account || hit.name, name: hit.name, seat: hit.name }, protocolVersion: 1 });
    });
    return;
  }

  // ── 本机签发配对码（10-12 用户：「配对码从哪里来 / 新手都不知道咋用」）──────────
  // 此前唯一入口是命令行 `--add-user`（普通用户不会用）。现在配对框里一键签发：
  //   名称可选，留空则自动叫「本机用户」。签发即返回，界面上直接展示/填入。
  // ⛔ 为什么这个端点**不过 token 闸**：未配对时本来就没有 token，一上闸就死锁。
  //   信任边界说明：服务只绑 127.0.0.1 ⇒ 能调它的只有本机进程，而本机进程本来就能直接读
  //   users.json / 跑 --add-user，所以不额外暴露。仍加限流（60 秒窗口内 3 次）防脚本刷。
  if (p === "/api/issue-code" && req.method === "POST") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    /* ⛔ 开闸时签发配对码必须**先配对并绑定账号**：未配对的人请去网页注册 ——
       不加这条，「必须先注册」就能靠界面内一键签发绕开（签发即得码，码即一个座位）。 */
    if (GATED) {
      const seat = whoByToken(tokenOf(req, url), loadChcUsers());
      if (!seat) { deny(401, { ok: false, error: "unauthorized" }); return; }
      if (!accountOf(seat)) { deny(403, { ok: false, error: "account-not-bound" }); return; }
    }
    if (Date.now() < issueLockedUntil) { deny(429, { ok: false, error: "too_many", retryAfterMs: issueLockedUntil - Date.now() }); return; }
    issueWindow += 1;
    if (issueWindow > ISSUE_MAX) { issueLockedUntil = Date.now() + ISSUE_WINDOW_MS; issueWindow = 0; console.log("[issue] 签发过于频繁，锁定 60 秒"); deny(429, { ok: false, error: "too_many" }); return; }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 4 * 1024) req.destroy(); });
    req.on("end", () => {
      let name = "";
      try { name = String((JSON.parse(raw || "{}") as { name?: unknown }).name || "").trim().slice(0, 32); } catch { /* 空 body 也可 */ }
      if (!name) name = `本机用户-${randomBytes(2).toString("hex")}`;
      try {
        const users = loadChcUsers();
        // 同名则复用（重新签发一把新码，旧的作废）——避免点两次生成两个"本机用户"
        const idx = users.findIndex((u) => u.name === name);
        const user: ChcUser = { name, code: randomBytes(4).toString("hex"), token: randomBytes(24).toString("hex"), createdAt: Date.now() };
        if (idx >= 0) users[idx] = user;
        else users.push(user);
        persistChcUsers(users);
        console.log(`[issue] 已签发配对码：用户「${name}」（界面内一键签发）`);
        deny(200, { ok: true, code: user.code, name: user.name });
      } catch (error) {
        console.error("[issue] 签发失败：", error);
        deny(500, { ok: false, error: "issue_failed" });
      }
    });
    return;
  }

  /* ── 云端管理（10-13 二期）：状态 + 断开连接（界面「云端管理」页的数据源）──── */
  if (p === "/api/cloud-state") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    const seat = whoByToken(tokenOf(req, url), loadChcUsers());
    const bindings = loadAccountBindings();
    deny(200, {
      ok: true,
      gated: GATED,
      paired: Boolean(seat),
      /* ⛔ machine* 是**整机状态**（有没有任何座位绑定了账号）—— 云端管理面板用它；
         paired / account 是**请求者**状态（带令牌才有）。两者口径不同，缺一不可。 */
      machinePaired: boundAccounts().length > 0,
      machineAccounts: boundAccounts(),
      account: seat ? (GATED ? accountOf(seat) : seat) : null,
      seats: bindings,
      hasDeviceToken: existsSync(deviceTokenFile),
      serverReachable: cloudReachable,
      webEntry: ASSISTANT_WEB_ENTRY,
      /** 方案扩展位：A+（云端会话索引）/ B（云端执行）在这里声明能力，界面按位渲染 */
      plan: "A",
      cloudFeatures: { sessionIndex: false, cloudExec: false },
    });
    return;
  }
  /* 断开连接：清空全部绑定 + 设备 token ⇒ 界面清掉本地令牌后回到配对卡。 */
  if (p === "/api/cloud-disconnect" && req.method === "POST") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    if (!bridgeAuthOk(req, url)) { deny(401, { ok: false, error: "unauthorized" }); return; }
    persistAccountBindings({ owner: "", users: {} });
    try { rmSync(deviceTokenFile, { force: true }); } catch { /* 忽略 */ }
    console.log("[cloud] 已断开云端连接（清空账号绑定与设备 token）");
    deny(200, { ok: true });
    return;
  }
  /* OAuth 授权：主进程**直开**系统浏览器（渲染层不依赖 codex 桥，点按钮就 fetch 这里）。 */
  if (p === "/api/open-auth" && req.method === "POST") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    openAuthPage();
    deny(200, { ok: true });
    return;
  }
  /* ── ④ 账号状态轮询（架构 §6.4）：已绑定后每 60s 用**设备令牌**问一次 /me ───────────
   账号被停用 / 设备被解绑 ⇒ 服务器 401/403 ⇒ 本机摘除绑定 + 清设备令牌
   ⇒ 界面下一次请求 401 ⇒ 回 /pair（闸重判）—— 运行期闭环，不等用户投诉。
   ⛔ 失败放行：服务不可达不误杀（本地能力照常）。 */
function pollAccountStatus(): void {
  if (!GATED) return;
  const deviceToken = readDeviceToken();
  if (!deviceToken) return;
  void (async () => {
    try {
      const r = await fetch(`${ACCOUNTS_BASE}/device/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 401 || r.status === 403) {
        persistAccountBindings({ owner: "", users: {} });
        try { rmSync(deviceTokenFile, { force: true }); } catch { /* 忽略 */ }
        console.log("[cloud] 账号已失效（停用/解绑）⇒ 已摘除本地绑定，界面下次请求将回到配对页");
      }
    } catch { /* 服务不可达：放行（本地能力不受影响） */ }
  })();
}
setInterval(pollAccountStatus, 60_000);

/* ── ⑤ 设备令牌更新通道（架构 §9.5）：本机带**设备令牌**问服务器要版本信息 ────── */
if (p === "/api/cloud-update-check" && req.method === "GET") {
  if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
  const deviceToken = readDeviceToken();
  if (!GATED || !deviceToken) { deny(404, { ok: false, error: "no-device-token" }); return; }
  void (async () => {
    try {
      const r = await fetch(`${ACCOUNTS_BASE}/device/update/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}` },
        signal: AbortSignal.timeout(8000),
      });
      const meta = await r.json().catch(() => null);
      if (!r.ok || !meta?.ok) { deny(502, { ok: false, error: "update-check-failed" }); return; }
      deny(200, { ok: true, available: Boolean(meta.available), latest: String(meta.latest || ""), url: String(meta.url || ""), notes: String(meta.notes || "") });
    } catch {
      deny(502, { ok: false, error: "accounts-unreachable" });
    }
  })();
  return;
}
  if (p === "/api/app-quit" && req.method === "POST") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    mutableState.closeConfirmed = true;
    app.quit();
    deny(200, { ok: true });
    return;
  }
  /* 授权回调页「跳转到应用」：把助手窗口调到前台（浏览器本页就可以关了）。 */
  if (p === "/api/focus-app" && req.method === "POST") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    void showAssistantWindow();
    deny(200, { ok: true });
    return;
  }

  /* ── OAuth 式浏览器授权（10-13 晚）：回调页 + 授权态令牌交接 ─────────────────
     流程：本机点「授权」→ 系统浏览器打开网页（?claim=<本机码> 预填）→ 用户注册/登录并
     认领 → 网页 **302 回本机 /auth/callback?code=<码>** → 本机回调页轮询绑定状态，
     绑定完成即把本地令牌写进 localStorage 并进入界面。
     ⛔ 轮询（/api/cloud-state 的 machinePaired）是兜底：就算浏览器拦截了重定向，
        本机的 5 秒认领轮询照样会完成绑定（双保险）。 */
  /* ── 独立配对页（10-14 重构）：未配对时外壳整体重定向到这里 ───────────────────
     ⛔ 自包含静态页：**不加载任何应用代码**（无启动图、无动画、无请求、无 401 噪音）。
     配对码由服务端直出（页面里就是最终值，不靠 JS 状态）；完成后本页自己写令牌并跳回 `/`。 */
  if (p === "/pair") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    const pairCode = GATED ? issueOwnerPair() : "";
    const pairPage = `<!DOCTYPE html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"/>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"/><title>连接云端账号 · Codex Assistant</title>` +
      `<style>html,body{margin:0;min-height:100%;background:#141413;color:#ececea;` +
      `font:14px/1.6 Inter,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;` +
      `display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}` +
      `.box{text-align:center;max-width:400px;padding:32px;width:90%}` +
      `.t{font-size:15px;font-weight:600;margin-bottom:14px}` +
      `.row{display:flex;align-items:center;gap:8px;margin:6px 0 4px}` +
      `.code{flex:1;font:700 24px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.3em;text-indent:.3em;` +
      `padding:12px 6px;background:#ffffff0a;border:1px solid #ffffff17;border-radius:10px}` +
      `button{appearance:none;-webkit-appearance:none;font:inherit;cursor:pointer;border:0}` +
      `.cp{flex:none;padding:10px 12px;border:1px solid #ffffff2e;background:#ffffff0f;color:inherit;border-radius:10px;font-size:12.5px}` +
      `.cap{font-size:11.5px;color:#7c7c76;margin:0 0 14px}` +
      `.st{font-size:12.5px;color:#a6a6a1;line-height:1.8;margin-bottom:14px;min-height:20px}` +
      `.go{display:block;width:100%;padding:10px 0;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;` +
      `border-radius:10px;font-size:13.5px;font-weight:600;margin-bottom:8px}` +
      `.go:hover{filter:brightness(1.08)}` +
      `.quit{display:block;width:100%;padding:8px 0;background:transparent;color:#a6a6a1;` +
      `border:1px solid #ffffff2e;border-radius:10px;font-size:12.5px}` +
      `.fb{display:none;font-size:11.5px;color:#7c7c76;line-height:1.7;margin-bottom:8px;word-break:break-all}` +
      `.bad{color:#ec7a70}</style></head><body><div class="box">` +
      `<div class="t">连接云端账号</div>` +
      (pairCode
        ? `<div class="row"><div class="code">${pairCode}</div><button class="cp" id="cp">复制</button></div>` +
          `<div class="cap">本机配对码 · 在网页上认领时填这个</div>`
        : `<div class="cap">本机码生成中，稍候刷新本页</div>`) +
      `<div class="st" id="st">等待浏览器授权…</div>` +
      `<button class="go" id="go">打开授权页面</button>` +
      `<div class="fb" id="fb"></div>` +
      `<button class="quit" id="quit">取消并退出应用</button></div>` +
      `<script>(function(){var code=${JSON.stringify(pairCode)};var web=${JSON.stringify(ASSISTANT_WEB_ENTRY)};` +
      `var url=web+"?claim="+code;var tries=0;` +
      `function st(t){document.getElementById("st").textContent=t}` +
      `document.getElementById("go").onclick=function(){` +
      `document.getElementById("fb").style.display="block";` +
      `document.getElementById("fb").innerHTML='若浏览器没有弹到前面，可复制链接手动打开：<br><b>'+url+"</b>";` +
      `fetch("/api/open-auth",{method:"POST"}).catch(function(){})};` +
      `document.getElementById("quit").onclick=function(){fetch("/api/app-quit",{method:"POST"}).catch(function(){})};` +
      `var cp=document.getElementById("cp");` +
      `if(cp)cp.onclick=function(){function fin(){cp.textContent="已复制 ✓";setTimeout(function(){cp.textContent="复制"},1500)}` +
      `if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(code).then(fin,fin)}else{fin()}};` +
      `/* 认领完成 ⇒ 凭码取本地令牌 ⇒ 写 localStorage ⇒ 回 /（闸放行，应用才启动） */` +
      `function tick(){fetch("/api/cloud-state",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){` +
      `if(s&&s.machinePaired){` +
      `st("已认领，正在完成连接…");` +
      `fetch("/api/pair-token-for-callback?code="+encodeURIComponent(code),{cache:"no-store"})` +
      `.then(function(r){return r.json()}).then(function(j){` +
      `if(j&&j.ok&&j.token){try{localStorage.setItem("chc-token",j.token)}catch(e){}}location.replace("/")})` +
      `.catch(function(){location.replace("/")});return}` +
      `if(++tries>90){st("等待超时：网页上还没有完成认领。可点「打开授权页面」重试。");return}` +
      `setTimeout(tick,2000)})}tick();})();</script></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(pairPage);
    return;
  }
  if (p === "/auth/callback") {
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    const claimCode = String(url.searchParams.get("code") || "").replace(/[^0-9a-f]/g, "").slice(0, 8);
    /* ⛔ 10-13 晚（用户反馈）：回调完成后**不在浏览器里加载主界面**（会多出一个完整的浏览器版应用），
       只给「登录成功 + 跳转到应用」——跳转 = 主进程把助手窗口调到前台，浏览器本页随手关掉。 */
    const okPage = `<!DOCTYPE html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"/>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"/><title>授权完成 · Codex Assistant</title>` +
      `<style>html,body{margin:0;min-height:100%;background:#141413;color:#ececea;font:14px/1.6 Inter,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center}` +
      `.box{text-align:center;max-width:380px;padding:32px}.t{font-size:17px;font-weight:600;margin-bottom:8px}` +
      `.d{font-size:12.5px;color:#a6a6a1;line-height:1.8}.spin{display:inline-block;width:16px;height:16px;border-radius:50%;` +
      `border:2px solid #7c3aed;border-top-color:transparent;animation:s .8s linear infinite;vertical-align:-3px;margin-right:8px}` +
      `@keyframes s{to{transform:rotate(360deg)}}.bad{color:#ec7a70}` +
      `.j{display:inline-block;margin-top:14px;padding:10px 22px;border:0;border-radius:10px;cursor:pointer;font-size:13.5px;font-weight:600;` +
      `background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff}.m{font-size:11.5px;color:#7c7c76}</style></head><body><div class="box">` +
      `<div class="t" id="t">正在完成授权</div><div class="d" id="d"><span class="spin"></span>正在连接本机应用…</div></div>` +
      `<script>(function(){var code=${JSON.stringify(claimCode)};var tries=0;` +
      `function focusApp(){fetch("/api/focus-app",{method:"POST"}).catch(function(){})}` +
      `function done(){document.getElementById("t").textContent="登录成功 · 已连接";` +
      `fetch("/api/pair-token-for-callback?code="+encodeURIComponent(code),{cache:"no-store"})` +
      `.then(function(r){return r.json()}).then(function(j){` +
      `if(j&&j.ok&&j.token){try{localStorage.setItem("chc-token",j.token)}catch(e){}}` +
      `document.getElementById("d").innerHTML="已在本机完成登录并连接云端。<br>"+` +
      `'<button class="j" id="j">跳转到应用</button><br><span class="m">点击后切换到应用窗口，本页可以关闭</span>';` +
      `document.getElementById("j").onclick=function(){focusApp();` +
      `document.getElementById("d").innerHTML="已切换到应用窗口，本页可以关闭。"};` +
      `focusApp();})` +
      `.catch(function(){location.replace("/")})}` +
      `function fail(m){document.getElementById("t").textContent="授权未完成";document.getElementById("d").innerHTML='<span class="bad">'+m+'</span><br>可回到本机窗口点「重新打开授权页面」重试。';}` +
      `function tick(){fetch("/api/cloud-state",{cache:"no-store"}).then(function(r){return r.json()}).then(function(s){` +
      `if(s&&s.machinePaired){done();return}` +
      `if(++tries>40){fail("等待超时：本机没有收到认领结果。请确认网页上的认领是否成功，然后回到本机窗口重试。");return}` +
      `setTimeout(tick,600)})}tick();})();</script></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(okPage);
    return;
  }
  /* 授权回包：凭本机码取本地令牌。⛔ 码必须与账号服务上「已认领」的记录对得上
     （服务端真相源）—— 否则任何人拿一个编造的码就能换出本地令牌（首轮实现漏了这条，已补）。 */  if (p === "/api/pair-token-for-callback" && req.method === "GET") {
    if (!GATED) { deny(404, { ok: false, error: "standalone" }); return; }
    if (!originAllowed(origin)) { deny(403, { ok: false, error: "origin-not-allowed" }); return; }
    const claimCode = String(url.searchParams.get("code") || "").replace(/[^0-9a-f]/g, "").slice(0, 8);
    if (!claimCode) { deny(404, { ok: false, error: "not-claimed" }); return; }
    void (async () => {
      try {
        /* ⛔ 已绑定 ⇒ 本机早就完成过认领（accounts.json 有主）⇒ **直接发本地令牌**：
           浏览器/新窗口只是来取会话的，不该被"码没被认领过"卡死（用户实测：机器已绑定，
           配对页永远停在"等待浏览器授权"）。码的真相源校验只对**未绑定**态做
           （防编造的码提前换令牌）。 */
        const bound = boundAccounts();
        if (bound.length === 0) {
          const check = await fetch(`${ACCOUNTS_BASE}/device/claim-status?code=${encodeURIComponent(claimCode)}`, { signal: AbortSignal.timeout(8000) });
          const meta = (await check.json().catch(() => null)) as { ok?: boolean; claimed?: boolean; username?: unknown } | null;
          if (!check.ok || !meta?.ok || !meta.claimed) { deny(404, { ok: false, error: "not-claimed" }); return; }
          bindSeat("owner", String(meta.username || ""));
        } else if (!accountOf("owner")) {
          bindSeat("owner", bound[0]);
        }
        deny(200, { ok: true, token: ownerToken, account: accountOf("owner") || bound[0] || "" });
      } catch {
        deny(502, { ok: false, error: "accounts-unreachable" });
      }
    })();
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
const shimJs = buildShim(manifest, onChannels, GATED);

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
  console.log(`[headless] 配对闸：${GATED ? `开 —— 必须先在网页注册账号（${ASSISTANT_WEB_ENTRY}），票据由本机向 ${ACCOUNTS_BASE} 核销` : "关 —— 独立模式（未配置账号服务）：本机码即可配对，无账号校验"}`);
  // ⛔ 配对码只打在控制台：能看到这行输出的人才配得上这台机器（与伴生服务同一条信任模型）
  printOwnerPairBanner();
  // 账号状态轮询：账号被停用后，已签发的令牌也要失效（失败放行，见 pollAccountStatus 头注）
  setInterval(pollAccountStatus, ACCOUNT_POLL_MS).unref();
  void pollAccountStatus();
  // 设备入网轮询：等网页认领本机码（认领 ⇒ 绑定账号 + 落盘设备 token ⇒ 允许连服务器）
  setInterval(pollDeviceClaim, 5000).unref();
  void pollDeviceClaim();
});

// 真 main.ts：86 个域 / 真引擎 / 全部业务。⛔ 必须最后 require。
require("./main");

/* ── ⑥ 独立窗口的无头形态：弹到用户的浏览器 ───────────────────────────────
   桌面版「独立窗口」= 新开一个 Electron 窗口；无头下窗口永远隐藏，浏览器用户
   什么都看不到（实测 bug）。改为：真实通道照常执行（保留 popout 登记/事件路由），
   然后**在用户默认浏览器里弹独立标签页** http://127.0.0.1:8917/?popout=<threadId>
   —— 同一套 dist + 同一份 shim，浏览器标签页就是无头版的"独立窗口"。
   ⛔ 必须在 require("./main") 之后包（handler 由域模块注册）。
   弹浏览器动作收敛到 electron/open-browser.ts（启动自动弹 / 托盘项共用同一份实现）。 */
const popoutHandler = invokeHandlers.get("window:popout-thread");
if (popoutHandler) {
  invokeHandlers.set("window:popout-thread", async (event, ...args) => {
    const result = await popoutHandler(event, ...args);
    const threadId = String(args[0] ?? "");
    const url = `http://127.0.0.1:${PORT}/?popout=${encodeURIComponent(threadId)}`;
    if (openInBrowser(url)) console.log(`[headless] 独立窗口 → 浏览器标签页 ${url}`);
    return result;
  });
} else {
  console.error("[headless] ⛔ window:popout-thread 无 handler，独立窗口桥未接线");
}

/* ── ⑦ 启动后把界面递给用户（10-12 两次迭代）────────────────────────────────
   0.0.2 症状：装完「什么都不出现」（无可见窗口 + 没人开浏览器 + 托盘没有入口）。
   0.0.3 症状（用户反馈）："打开主界面就是浏览器，只有配对那一下该用浏览器吧？"
   ⇒ 定稿：**助手自己开一个可见的应用窗口**（加载 http://127.0.0.1:PORT/，含 shim ⇒
   配对框就在窗口里，首次配对也在窗口内完成，不用碰浏览器）；任务栏有图标、关窗只是
   隐藏（服务继续给浏览器 / 手机用）。浏览器打开仍旧可用（同一地址），只是不再是主形态。
   ⛔ 窗口创建失败（极端环境）才兜底弹浏览器 —— 别让用户面前又什么都没有。 */
if (process.env.HARNESS_ASSISTANT === "1") {
  // 延迟一拍：等 main.ts 的引擎/托盘把首屏数据备好，窗口加载出来就有内容（而不是白屏转圈）
  setTimeout(() => {
    void showAssistantWindow().then((ok) => {
      if (ok) console.log("[headless] 助手启动 → 已开应用窗口");
      else if (openInBrowser(assistantUrl())) console.log(`[headless] 窗口创建失败 → 兜底弹浏览器 ${assistantUrl()}`);
      /* ⛔ OAuth 式授权（10-13 晚）：开闸且未配对 ⇒ **主进程自动唤起系统浏览器**打开授权页
         （?claim= 预填本机码）—— 用户零操作；卡片上的按钮只是"重新打开"的入口。 */
      if (ok && GATED && !boundAccounts().length && !authAutoOpened) {
        authAutoOpened = true;
        setTimeout(() => openAuthPage(), 1200);
      }
    });
  }, 1500);
}
