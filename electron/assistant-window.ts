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
import { BrowserWindow } from "electron";
import { assistantUrl } from "./open-browser";

type AssistantWin = {
  show: () => void;
  focus: () => void;
  hide: () => void;
  isDestroyed: () => boolean;
  setTitle: (t: string) => void;
  loadURL: (url: string) => Promise<void>;
  on: (event: string, cb: (e?: { preventDefault: () => void }) => void) => void;
};

const WINDOW_TITLE = "Codex Harness Assistant";

let pending = false;
let win: AssistantWin | null = null;

/** browser-window-created 里判断「这个窗口是不是助手主窗口」（headless.ts 调用）。 */
export function isAssistantWindowPending(): boolean {
  return pending;
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
    });
  } catch (error) {
    pending = false;
    console.error("[assistant-window] 创建窗口失败：", error);
    return false;
  }
  pending = false;
  const w = created as unknown as AssistantWin;
  // ⛔ 标题必须钉住：页面 HTML 的 <title> 是桌面版那套（"Codex Harness" / "…Desktop"），
  //   加载后 Electron 默认会用它覆盖窗口标题（10-12 实测：助手窗口顶着桌面版的名字）。
  //   page-title-updated 里 preventDefault ⇒ 标题恒为 WINDOW_TITLE。
  w.on("page-title-updated", (e) => e?.preventDefault());
  w.setTitle(WINDOW_TITLE);
  // 关窗只隐藏（保服务）；closed 后清引用，下次 show 时重建
  w.on("close", (e) => {
    e?.preventDefault();
    w.hide();
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
    win.show();
    win.focus();
    return true;
  }
  return createAssistantWindow();
}
