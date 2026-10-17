/**
 * window-factory（09-21 架构改造：从 electron/main.ts 组合根按符号拆出，纯搬迁）
 *
 * 搬出符号：createWindow / createPopoutWindow
 *
 * 代码与原地逐字一致（仅顶部 import + 文件头注释）。
 * 跨域符号经 `import … from "../main"` 取用 —— **活绑定**（TS→CJS 编译成 `main_1.X` 属性访问）。
 * 会被重新赋值的符号经 `mutableState` 访问器读写（ESM 里 import 的绑定不可赋值）。
 */
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, shell } from "electron";
import { isAssistantRuntime } from "../updates";
import { showAssistantWindow } from "../assistant-window";
import { existsSync } from "node:fs";
import { applyRoundedCorners } from "../win-rounded-corners";
import { resolveWindowIcon } from "../app-icon";
import { popoutBusWindows, registerBusWindow, unregisterBusWindow } from "../features/window-bus";
import { flushBootTiming, markBoot } from "../boot-timing";
import { installContextMenu } from "../main/10-window-menu";
import { applyThemeToWindow, closeToTrayEnabled, closePromptSeen, closeConfirmBridge, engineActiveTurnIds, notifyPopoutClosed, popoutThreadIds, titleBarOverlayOptions } from "../runtime-refs";
import { closePetWindow } from "./pet-window";
import { mutableState } from "../main";
import { isInsideTrustedRoots } from "../runtime-refs";
export function createWindow() {
  // ⛔⛔ 助手形态（headless）：**根本不创建桌面版主窗**。
  //   10-12 幽灵窗口事故：此前助手形态照样创建主窗、靠「创建后 hide + 短路 win.show/focus」按住它，
  //   一旦有别的路径把它叫出来（second-instance → showMainWindow、托盘「显示主窗口」）就露出来，
  //   而它的任务栏标志早被摘掉 ⇒ **窗口在、任务栏没有**的幽灵形态；再叠加助手自己的可见窗口
  //   就成了"两层窗口"。**不可见性必须由「压根不创建」保证，不能靠创建后按住。**
  //   助手的界面统一由 electron/assistant-window.ts 自管（加载 http://127.0.0.1:PORT/）。
  if (isAssistantRuntime()) {
    void showAssistantWindow();
    return;
  }
  // Windows 任务栏图标必须用 .ico 才可靠（PNG 会被 electron.exe 默认图标顶掉）；
  // ⛔ 资源定位锚在 app.getAppPath()（dev = 仓库根 / 打包 = app.asar 根），**不要用 __dirname**：
  //    features/ 下的 __dirname 是 dist-electron/features，`..` 会落到 dist-electron 里
  //    （09-21 架构改造把本模块从 electron/main.ts 搬进 features/ 时正是这样把图标/渲染层/preload 三个路径一起打歪的）。
  // 打包后 build/ 不进 asar（files 白名单只有 dist/**、dist-electron/**），existsSync 为 false
  // 走 exe 内嵌图标（electron-builder win.icon 已注入）。
  // ⛔⛔ 多源兜底（09-27 修「保存供应商重启后任务栏图标变默认」）：**只认 app.getAppPath() 一条
  //    路径是脆的** —— relaunch / 从快捷方式启动 / cwd 变化等场景下 appPath 可能不落在仓库根
  //    （实测探针里 appPath 会落成启动脚本所在目录），此时 existsSync=false ⇒ `icon: undefined`
  //    ⇒ 窗口图标失效 ⇒ dev 下没有 AUMID 兜底 ⇒ 任务栏回退 Electron 原子图标。
  //    ⇒ 依次尝试 appPath / execPath 上溯 / cwd，**取第一个真实存在的**；都对才放弃。
  const iconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  // ⛔ 图标链路真相源 = ../app-icon.ts（10-12 抽出）：dev 从快捷方式启动时 appPath = 入口脚本
  //    所在目录（dist-electron），下面这条单一路径必空 ⇒ 任务栏回退 Electron 默认原子（用户实证）。
  //    多源兜底（appPath / __dirname 上溯 / execPath 上溯 / cwd）收在那一个模块里。
  const windowIcon = resolveWindowIcon() ?? path.join(app.getAppPath(), "build", iconName);
  mutableState.mainWindow = new BrowserWindow({
    // 默认桌面尺寸要容纳展开侧栏和完整输入工具栏；小屏仍由响应式布局处理。
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#ffffff",
    title: "Codex Harness Desktop",
    icon: existsSync(windowIcon) ? windowIcon : undefined,
    autoHideMenuBar: true,
    // 无边框标题栏：系统标题栏隐藏，应用 topbar 顶到窗口边缘（省 ~32px 高度）。
    // ⛔ 平台分叉（09-16 mac 适配）：titleBarOverlay 的窗口控制钮是 **Windows 专属**
    // （右上角贴靠/双击最大化等原生行为）；mac 上硬传只是被忽略，红绿灯仍画在左上角，
    // 而渲染层按 Windows 预留的右上 145px 空白就成了纯浪费。mac 走 hiddenInset——
    // 红绿灯按系统标准内缩，渲染层用 [data-os="darwin"] 把顶行内容让开（styles.css）。
    ...(process.platform === "win32"
      ? {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: {
          // 让 `.topbar { background: var(--bg) }` 自己穿过来——钮不再"浮在自己的色条上"，
          // 也无需枚举每个主题调色；亮/暗主题都能干净。符号色在 theme:apply 里跟着主题切。
          color: "#00000000",
          symbolColor: titleBarOverlayOptions().symbolColor,
          // 43 而非 44：底下留 1px 给 .topbar::after 分隔线，线可贯通窗口钮下方
          height: 43,
        },
      }
      : { titleBarStyle: "hiddenInset" as const }),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // <webview> 标签（Electron 默认禁用）：主区「浏览器」视图用它嵌入外部网页。
      // guest 内容是独立 webContents，与主应用隔离（拿不到 preload / node API），
      // 仅用于渲染，不赋予任何宿主权限。
      webviewTag: true,
    },
  });
  // ⛔ 任务栏图标重申（09-27 用户实测：自动重启后图标被顶成默认）：icon 选项在窗口构造期
  //    应用，但 relaunch/快速重启场景下任务栏分组重建可能吞掉它。ready-to-show 后 setIcon
  //    再申明一次——同一文件、幂等，成本为零；图标链路真相源见 main.ts AUMID 注释与附录 G。
  if (process.platform === "win32" && existsSync(windowIcon)) {
    mutableState.mainWindow.once("ready-to-show", () => {
      try { mutableState.mainWindow?.setIcon(windowIcon); } catch { /* 图标重申失败不影响功能 */ }
    });
  }
  // Windows 11 原生圆角（仅 win32；其余平台函数内静默跳过）。
  applyRoundedCorners(mutableState.mainWindow);
  // 登记进窗口广播总线：主窗口 ⇒ sendToWindow 只发它，broadcast* 发全部窗口（见 features/window-bus）
  registerBusWindow(mutableState.mainWindow, { primary: true });
  // ⛔ 导航与新窗口收敛（09-13 审计 S5）：全仓此前 `will-navigate` / `setWindowOpenHandler`
  // **零命中** —— 主窗口加载了任意页面（模型输出里的链接、拖入的本地 html）就能在当前
  // webContents 里换掉整个应用界面，而它带着 `harness-image://` 与全部 IPC 桥。
  // 规则：**主窗口自身永不导航**（应用只从 dist/devServer 加载），新窗口一律拒绝并转系统浏览器。
  mutableState.mainWindow.webContents.on("will-navigate", (event, target) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? "";
    if (devUrl && target.startsWith(devUrl)) return;   // 开发期 HMR reload 放行
    if (target.startsWith("file://") && target.includes("/dist/index.html")) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) void shell.openExternal(target).catch(() => undefined);
  });
  mutableState.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  // <webview> guest 只允许 http(s) 且禁弹窗；不给它任何宿主权限（分区隔离见 BrowserPane）。
  mutableState.mainWindow.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete (webPreferences as any).preload;
    (webPreferences as any).nodeIntegration = false;
    (webPreferences as any).contextIsolation = true;
    /* ⛔⛔ guest 的 src 收敛：http(s) 放行；**可信本地 HTML 也放行**（10-17 同步自主仓 997efc2 ——
       文件预览「浏览器打开」空白页的根因：file: 的 src 在此被删 ⇒ guest 从未导航 ⇒ 空白无事件）。
       口径与 external:open 一致：.html + fileURLToPath 可解 + isInsideTrustedRoots 之内；其余照旧删 src。 */
    const attachSrc = String(params.src ?? "");
    if (/^https?:/i.test(attachSrc)) return;
    if (/^file:/i.test(attachSrc)) {
      try {
        const previewPath = fileURLToPath(new URL(attachSrc));
        if (/\.html?$/i.test(previewPath) && isInsideTrustedRoots(previewPath)) return;
      } catch { /* 非法 URL → 照旧删 */ }
    }
    delete (params as any).src;
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  // ⛔ 关窗守卫（09-13 审计第 5 条）：此前全 `main.ts` **没有 `mainWindow.on("close")`、没有确认框**，
  // 而 `cleanupAll()` 里 `server.stop()` 直接 kill 引擎 —— 长任务流式中点关闭 = 该回合在 rollout 里
  // 没有 task_complete（半截），排队中的消息随引擎内存一起消失。
  // 只做一件事：**有在跑回合时先问一句**。不阻塞主进程（异步对话框 + preventDefault + 二次 close）。
  mutableState.mainWindow.on("close", (event) => {
    // ⛔ 退出路径（托盘「退出」/ Cmd+Q / 系统关机 → before-quit 置 closeConfirmed=true）
    //    一律直接放行 —— 这里再弹任何确认框都会让应用退不出去。
    if (mutableState.closeConfirmed) return;
    // ⛔ 托盘「关闭窗口时最小化到托盘」（09-23 用户要求托盘常驻）：开着时 X 只隐藏窗口 ——
    //    引擎 / 调度器 / 渠道机器人 / 正在跑的回合全都不中断。必须排在其它分支之前：
    //    隐藏不中断任何东西，这时再弹"关闭会中断回合"的警告只会吓人。
    if (closeToTrayEnabled()) {
      event.preventDefault();
      mutableState.mainWindow?.hide();
      // 留一行日志：这条分支是"点了 X 却不退出"的地方，出问题时**必须能从日志里看出它到底走没走**
      // （否则只能靠猜"是不是开关没读到 / 事件没触发"）。e2e 也用它做判据。
      console.log("[tray] 关闭被拦截 → 隐藏主窗口（closeToTray 开启；退出走托盘「退出」/ Cmd+Q）");
      return;
    }
    // ⛔ 「不再询问」已记住动作（10-13）：到这里 = 用户记住的是**完全退出**（选「最小化到托盘」
    //    的情形已被上一条拦下 —— 记住的动作就是 closeToTray=true）⇒ 直接放行 close。
    //    ⛔ 不再看"任务在跑"：勾了「不再询问」= 明确说了别再问，跑着也照退（弹窗里已说明会停工作）。
    if (closePromptSeen()) return;
    // ⛔ 关闭确认弹窗（10-13 用户需求）：点 X 时弹**应用内**卡片「最小化到托盘 / 完全退出 / 取消」
    //    +「不再询问」—— 不再用原生系统框（要与整体界面风格一致，而不是一个突兀的系统窗）。
    //    实现：preventDefault 后把「要不要关」经 `close-confirm:ask` 推给渲染层，
    //    用户在应用内卡片上选，回包走 `close-confirm:respond`（close-confirm-ipc 域）→ respond 执行。
    event.preventDefault();
    closeConfirmBridge.pending = { busy: engineActiveTurnIds.size };
    mutableState.mainWindow?.webContents.send("close-confirm:ask", {
      busy: engineActiveTurnIds.size,
      appName: app.getName(),
    });
  });

  // 关窗回包的**执行端**：close-confirm-ipc 收到渲染层的选择后调这里（跨域桥，见 runtime-refs）。
  closeConfirmBridge.respond = (action) => {
    if (action === "tray") {
      // 最小化到托盘：只隐藏窗口，引擎 / 调度器 / 渠道机器人全都不中断
      mutableState.mainWindow?.hide();
      return;
    }
    if (action === "quit") {
      // 完全退出：弹窗里已明确告知会停止正在进行的工作 ⇒ 置旗后二次 close（绕过所有确认）
      mutableState.closeConfirmed = true;
      mutableState.mainWindow?.close();
    }
    // cancel：什么都不做
  };
  // 主窗口真正关闭后，独立会话弹窗跟着一起关（用户 09-13 明确要求「跟着主应用关闭」）。
  mutableState.mainWindow.on("closed", () => {
    for (const win of popoutBusWindows()) { if (!win.isDestroyed()) win.close(); }
    // 桌面宠物同理：它是**不登记进 window-bus** 的独立浮窗（见 features/pet-window.ts 头注释），
    // 不显式关掉的话它会在主窗口消失后继续孤零零飘在桌面上。
    try { closePetWindow(); } catch { /* 已关，忽略 */ }
  });
  const contents = mutableState.mainWindow.webContents;
  contents.on("did-start-loading", () => markBoot("page-start-loading"));
  contents.on("did-finish-load", () => { markBoot("page-finish-load"); flushBootTiming(); });
  // ⛔ 加载兜底（09-27 修 dev 白屏的第二道保险）：dev 下 VITE_DEV_SERVER_URL 指向的 vite
  //    可能已经不在（relaunch 后 concurrently -k 把它一起杀了，实测 ERR_CONNECTION_REFUSED
  //    ⇒ DOM 全空 = 白屏）。首道保险是 app:relaunch 里摘掉该变量；这里再兜一层——
  //    dev URL 加载失败就回落到本地 dist 产物，宁可看构建版也不能给用户留白屏。
  //    打包版无 devUrl，走下面的 loadFile，不受影响。
  if (devUrl) {
    const distIndex = path.join(app.getAppPath(), "dist", "index.html");
    mutableState.mainWindow.loadURL(devUrl).catch(() => {
      try { void mutableState.mainWindow?.loadFile(distIndex); } catch { /* 兜底失败不再处理 */ }
    });
  } else void mutableState.mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  /* ⛔⛔ 白屏自愈（10-03 用户实测两次白屏）：`npm run check` / 手工构建会先 `clean-dist` 清空
     dist 再重建，若窗口恰好在这个窗口期加载（或用户此时点开应用）⇒ did-fail-load，界面全白。
     这里不再留白：加载失败就换一页自刷新的提示页（3 秒重试一次），构建一完成自动回到真界面；
     同时把失败原因打在页面上，省得用户以为应用坏了。 */
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const appIndex = path.join(app.getAppPath(), "dist", "index.html");
    const retryUrl = pathToFileURL(appIndex).href;
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>正在准备界面…</title>
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:"Segoe UI",system-ui,sans-serif;background:#fff;color:#23231f}img{width:112px;height:112px;border-radius:26px}small{color:#6f6f69}</style>
</head><body><img src="${pathToFileURL(path.join(app.getAppPath(), "dist", "icon.png")).href}" alt="">
<strong>界面文件正在更新，3 秒后自动重试…</strong><small>（构建完成即自动进入；错误：${String(errorDescription ?? errorCode)}）</small>
<script>setTimeout(() => { location.replace(${JSON.stringify(retryUrl)}); }, 3000);</script></body></html>`;
    void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch(() => undefined);
  });
  installContextMenu(mutableState.mainWindow);
}

/**
 * 把主窗口带到用户眼前（托盘点按 / second-instance / mac activate 共用一条链路）：
 * 不存在则创建、最小化则还原、隐藏则显示，最后聚焦。
 * ⛔ 三处都别自己写 `mainWindow?.show()`：窗口被销毁后它只是 no-op，用户点了「显示主窗口」却什么都没发生。
 */
export function showMainWindow() {
  // 助手形态没有「桌面版主窗」⇒ 一律指向助手窗口（second-instance / 托盘「显示主窗口」都会走到这）
  if (isAssistantRuntime()) {
    void showAssistantWindow();
    return;
  }
  const win = mutableState.mainWindow;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** 独立窗口「建窗中」旗（10-16）：browser-window-created 在 `new BrowserWindow()` 内**同步**
 *  触发，那时还没有窗口实例可比对 ⇒ 只能用旗区分（与 assistant-window 的 pending 同一套办法）。
 *  用途：无头形态下 headless 要按它**放行可见**（独立窗口是给用户看的真窗口，
 *  不像桌面版主窗 / 宠物 / 截图遮罩那样必须藏起来）。 */
let pendingPopout = false;
export function isPopoutWindowPending(): boolean { return pendingPopout; }

export function createPopoutWindow(threadId: string) {
  const windowIcon = path.join(
    app.getAppPath(),
    "build",
    process.platform === "win32" ? "icon.ico" : "icon.png",
  );
  pendingPopout = true;
  const win = new BrowserWindow({
    // 1120 而非 1080：主布局在 ≤1080px 时隐藏消息刻度尺（media query），弹窗初始宽度
    // 必须避开这个断点，否则弹窗里看不到刻度线（用户截图反馈）。
    width: 1120,
    height: 760,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: "#ffffff",
    title: "Codex Harness Desktop — 独立会话",
    icon: existsSync(windowIcon) ? windowIcon : undefined,
    autoHideMenuBar: true,
    // 独立弹窗同款平台分叉（mac hiddenInset / win overlay），理由见 createWindow
    ...(process.platform === "win32"
      ? {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: titleBarOverlayOptions(),
      }
      : { titleBarStyle: "hiddenInset" as const }),
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 弹窗只渲染对话区，不需要 webview 标签
      webviewTag: false,
    },
  });
  pendingPopout = false;
  // Windows 11 原生圆角（仅 win32；其余平台函数内静默跳过）。
  applyRoundedCorners(win);
  // ⛔ 导航收敛与主窗口同规则：弹窗永不导航，新窗口一律拒绝并转系统浏览器。
  win.webContents.on("will-navigate", (event, target) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? "";
    if (devUrl && target.startsWith(devUrl)) return;   // 开发期 HMR reload 放行
    if (target.startsWith("file://") && target.includes("/dist/index.html")) return;
    event.preventDefault();
    if (/^https?:/i.test(target)) void shell.openExternal(target).catch(() => undefined);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });
  win.on("closed", () => {
    unregisterBusWindow(win);
    popoutThreadIds.delete(win);
    notifyPopoutClosed(threadId);
  });
  registerBusWindow(win);
  popoutThreadIds.set(win, threadId);
  /* ⛔ 弹窗原生外观（暗色下右上角系统钮看不见的真修法）：构造参数里那次
     titleBarOverlayOptions() 是**读一次**，而 Windows 会在窗口首次显示时做边框延展、
     把构造期设好的属性覆盖回系统值 ⇒ 补设两次（建窗 + show 之后），见 runtime-refs.applyThemeToWindow。 */
  applyThemeToWindow(win);
  win.once("show", () => applyThemeToWindow(win));
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const query = `?popout=${encodeURIComponent(threadId)}`;
  if (devUrl) {
    const sep = devUrl.includes("?") ? "&" : "?";
    void win.loadURL(devUrl + sep + query.slice(1));
  } else if (process.env.HARNESS_ASSISTANT === "1") {
    /* ⛔ 助手形态（10-16 用户令「这个云助手，不要打开网页啊」）：独立窗口 = **可见的真窗口**，
       加载与助手主窗**同一个 http origin**。同源 ⇒ 与助手窗共享 localStorage ⇒
       主题天然一致；此前"弹浏览器标签页"或"加载 file:// 本地 dist"都会各带一份
       自己的主题，挂载时的 themeApply 会把主窗的标题栏符号色刷反（深色顶栏上 = 右上角看不见）。
       可见性由 headless 的 browser-window-created 按 isPopoutWindowPending() 放行。 */
    const port = Number(process.env.HARNESS_HEADLESS_PORT || 8917);
    void win.loadURL(`http://127.0.0.1:${port}/${query}`);
  } else {
    void win.loadFile(path.join(app.getAppPath(), "dist", "index.html"), { query: { popout: threadId } });
  }
  installContextMenu(win);
  return win;
}
