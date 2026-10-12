/**
 * 用系统默认浏览器打开一个 URL（跨平台）—— 助手（无头）形态的「界面入口」
 *
 * ⛔ 10-12 实测（cloud-v0.0.2）：助手是 headless 形态，**没有可见窗口**；而启动链路里
 *   既没有自动打开浏览器、托盘也没有「打开界面」项 ⇒ 用户装完好比没装：服务在跑
 *   （8917 监听、托盘图标在），但面前什么都不出现，更看不到配对框。
 *   本模块把「弹浏览器」收敛成一处：启动后自动弹 + 托盘菜单手动弹 + 独立窗口弹都用它。
 *
 * 与 electron/headless.ts 里 `window:popout-thread` 早先的内联实现同形（cmd /c start、
 * detached + unref，不拖住退出）；抽出来是为了三处共用一份、不再各写一遍。
 */
import { spawn } from "node:child_process";

/** 助手本地界面地址（端口与 headless 的 PORT 同源：HARNESS_HEADLESS_PORT，默认 8917）。 */
export function assistantUrl(): string {
  const port = Number(process.env.HARNESS_HEADLESS_PORT || 8917);
  return `http://127.0.0.1:${port}/`;
}

/** 打开失败只打日志返回 false（调用方据此决定要不要降级提示），不抛。 */
export function openInBrowser(url: string): boolean {
  try {
    // ⛔ mac 适配：cmd /c start 是 Windows 专属；darwin 用 open，其余 xdg-open
    const openCmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const openArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(openCmd, openArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch (error) {
    console.error("[open-browser] 打开失败：", error);
    return false;
  }
}
