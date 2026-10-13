/**
 * 助手主窗口（10-12 用户定调：「配对走浏览器一次就行，后面要像正常应用一样启动」）
 *
 * 背景：助手是 headless 形态，此前 browser-window-created 把**所有**窗口永久隐藏 + 摘任务栏
 * ⇒ 用户装完好比没装：没有窗口、任务栏没有图标，只有一个托盘图标 + 一个浏览器标签页。
 *
 * 本模块自管一个**可见**主窗口（加载 http://127.0.0.1:PORT/ —— 同一份 dist + 同一份 shim，
 * 所以配对框 / 事件推送 / IPC 桥在窗口里全都在），桌面版 window-factory 的主窗 / 宠物 /
 * 弹出 / 截图遮罩仍旧隐藏 + 广播（那一套逻辑一行不动）。
 *
 * ⛔ browser-window-created 在 `new BrowserWindow()` 内**同步**触发（早于构造返回）⇒
 *   不能用「事后比对 assistantWindow」来区分，必须用 pending 旗（begin/end 成对）。
 * ⛔ 关窗 = 隐藏而不是退出：服务要继续给浏览器 / 手机端用；真退出走托盘「退出」。
 */
import { BrowserWindow, app } from "electron";
import { existsSync } from "node:fs";
import { assistantUrl } from "./open-browser";
import { resolveWindowIcon } from "./app-icon";
import { applyRoundedCorners } from "./win-rounded-corners";
import { titleBarOverlayOptions } from "./runtime-refs";
import { mutableState } from "./main";

type AssistantWin = {
  show: () => void;
  focus: () => void;
  hide: () => void;
  isDestroyed: () => boolean;
  setTitle: (t: string) => void;
  loadURL: (url: string) => Promise<void>;
  on: (event: string, cb: (e?: { preventDefault: () => void }) => void) => void;
};

const WINDOW_TITLE = "Codex Assistant";

let pending = false;
let win: AssistantWin | null = null;

/** browser-window-created 里判断「这个窗口是不是助手主窗口」（headless.ts 调用）。 */
export function isAssistantWindowPending(): boolean {
  return pending;
}

/** 助手主窗口实例（未创建/已销毁时返回 null）。
 *  用途：原生对话框（选目录/选文件）必须挂在一个**可见**窗口上 —— 10-12 实测：
 *  对话框以隐藏窗口为父时 Windows 不显示（用户报「云助手选不了本地项目地址」）。 */
export function getAssistantWindow(): AssistantWin | null {
  return win && !win.isDestroyed() ? win : null;
}

/** 创建（或重建）助手主窗口；失败返回 false（调用方可兜底弹浏览器）。 */
export async function createAssistantWindow(): Promise<boolean> {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return true;
  }
  pending = true;
  let created: BrowserWindow | null = null;
  // ⛔ 图标必须显式给（10-12 用户实证「任务栏是默认原子」）：dev 下 appPath 落在
  //   dist-electron（入口脚本目录）⇒ 不给 icon 就回退 electron.exe 默认图标。
  //   解析走 app-icon.ts 唯一真相源（多源兜底，含 __dirname 上溯）。
  const windowIcon = resolveWindowIcon();
  try {
    created = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: WINDOW_TITLE,
      show: true,
      autoHideMenuBar: true,
      backgroundColor: "#f7f7f5",
      icon: windowIcon ?? undefined,
      // ⛔ 显式保留任务栏按钮：browser-window-created 那套隐藏逻辑会摘任务栏，
      //   助手窗必须明确声明"我要出现在任务栏"（10-12："任务栏没有"即此处缺失/被摘）。
      skipTaskbar: false,
      // ⛔ 无边框 + 原生窗口钮（10-12 用户指出「上面边框跟 Codex Harness 不一样」）：
      //   桌面版主窗就是 hidden + titleBarOverlay（应用 topbar 顶到窗口边缘，右上角是
      //   原生最小化/最大化/关闭钮）—— 助手加载同一份 dist，同一套 topbar，必须同形态。
      //   overlay 参数取 runtime-refs.titleBarOverlayOptions()（符号色跟主题走的唯一真相源）。
      //   mac 走 hiddenInset（与桌面版同理由：红绿灯在左上，右上预留区不浪费）。
      ...(process.platform === "win32"
        ? { titleBarStyle: "hidden" as const, titleBarOverlay: titleBarOverlayOptions() }
        : { titleBarStyle: "hiddenInset" as const }),
    });
  } catch (error) {
    pending = false;
    console.error("[assistant-window] 创建窗口失败：", error);
    return false;
  }
  pending = false;
  // ⛔ 任务栏图标重申（照抄桌面版主窗 09-27 的修法）：relaunch/快速重启场景下任务栏分组
  //   重建可能吞掉构造期的 icon ⇒ ready-to-show 后 setIcon 再申明一次，幂等、零成本。
  if (process.platform === "win32" && windowIcon && existsSync(windowIcon)) {
    created.once("ready-to-show", () => {
      try { created?.setIcon(windowIcon); } catch { /* 图标重申失败不影响功能 */ }
    });
  }
  applyRoundedCorners(created);
  const w = created as unknown as AssistantWin;
  // ⛔ 双保险：构造参数 skipTaskbar:false 之外再显式调一次（某些 Windows 版本下首帧才生效）
  try { (created as unknown as { setSkipTaskbar: (v: boolean) => void }).setSkipTaskbar(false); } catch { /* 忽略 */ }
  // ⛔ 标题必须钉住：页面 HTML 的 <title> 是桌面版那套（"Codex Harness" / "…Desktop"），
  //   加载后 Electron 默认会用它覆盖窗口标题（10-12 实测：助手窗口顶着桌面版的名字）。
  //   page-title-updated 里 preventDefault ⇒ 标题恒为 WINDOW_TITLE。
  w.on("page-title-updated", (e) => e?.preventDefault());
  w.setTitle(WINDOW_TITLE);
  // 关窗：⛔⛔ 10-13 晚最终定版 —— **助手窗口的 X = 真退出**。
  //   此前两版（无提示 hide / 渲染层确认弹窗）连续三轮被用户打回：hide 后托盘图标在
  //   Windows 溢出区找不到 = "退不掉"；弹窗又被配对卡/层级问题遮挡 = "关不掉"。
  //   云助手是本地服务应用，X 退出符合直觉；常驻需求走托盘（显示主窗口/退出都在）。
  //   ⛔ 必须 app.quit() 且先置 closeConfirmed：无头形态下桌面主窗隐藏活着，
  //      只关助手窗 window-all-closed 不触发；主窗关窗守卫会把 quit 变成 hide。
  let assistantQuitStarted = false;
  w.on("close", (e) => {
    if (assistantQuitStarted || mutableState.closeConfirmed) return;   // 真关闭放行
    assistantQuitStarted = true;
    mutableState.closeConfirmed = true;
    app.quit();
  });
  w.on("closed", () => {
    if (win === w) win = null;
  });
  win = w;
  try {
    await w.loadURL(assistantUrl());
    return true;
  } catch (error) {
    console.error("[assistant-window] 加载本地界面失败：", error);
    return false;
  }
}

/** 显示并聚焦；窗口不在则重建。返回 false 表示彻底失败（调用方兜底）。 */
export async function showAssistantWindow(): Promise<boolean> {
  if (win && !win.isDestroyed()) {
    /* ⛔ 10-13 晚：**把窗口带回家** —— 窗口可能被旧版配对卡的原地链接导航去了网页
       （ppz123.asia/cloud/），此时 show/focus 只是把"卡在网页上的窗口"再显示一遍，
       用户看到的永远是登录门，重启都回不来（实测投诉："启动就是这个界面"）。
       判据：当前 URL 不是本机助手地址 ⇒ 重新 loadURL 回本机。 */
    try {
      /* AssistantWin 是窄接口 ⇒ webContents 走结构化断言（同 headless.ts 的做法） */
      const wc = (win as unknown as { webContents: { getURL: () => string; loadURL: (u: string) => Promise<void> } }).webContents;
      const url = wc.getURL();
      const local = `http://127.0.0.1:${Number(process.env.HARNESS_HEADLESS_PORT || 8917)}`;
      if (!url.startsWith(local) && !url.startsWith("http://localhost:")) {
        console.log(`[assistant-window] 窗口被导航去了 ${url.slice(0, 80)} ⇒ 带回本机界面`);
        await wc.loadURL(assistantUrl());
      }
    } catch { /* 读不到 URL 就照常显示 */ }
    win.show();
    win.focus();
    return true;
  }
  return createAssistantWindow();
}
