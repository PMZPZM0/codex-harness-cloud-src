/**
 * build/ 资源（应用图标 / 托盘图）路径的**唯一真相源**（10-12 从 features/window-factory.ts 抽出，
 * 供主窗、助手窗、托盘三处共用 —— 同一判据只许留一处）。
 *
 * ⛔⛔ 为什么要多源兜底（10-12 用户实证「任务栏/托盘全是 Electron 默认原子」）：
 *   dev 从快捷方式启动时传的是**入口脚本绝对路径**（`electron.exe <repo>/dist-electron/headless.js`），
 *   实测（probe-apppath.cjs）`app.getAppPath()` = **入口脚本所在目录**，不是仓库根 ⇒
 *   `appPath/build/tray.png` 不存在 ⇒ Tray 拿到 createEmpty() ⇒ 托盘/任务栏全回退默认原子。
 *   （打包版 appPath = asar 根，第一条命中；历史注释见 features/window-factory.ts 09-27 那段。）
 *
 * ⛔ __dirname 在这里**可用且正确**：本模块编译后固定落在 `dist-electron/app-icon.js`，
 *   `../build` = 仓库根/build（打包 = asar:/build，tray*.png 在 files 白名单里）。
 *   与 features/ 下"别用 __dirname"的告诫不冲突 —— 那条说的是 features/ 子目录（要多退一级）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/** 在多源候选里找 build/<name>，返回第一个真实存在的路径；都不在返回 null。 */
export function findBuildAsset(name: string): string | null {
  const candidates = [
    // 打包版：appPath = asar 根（tray*.png 在 files 白名单内，icon.ico 不在 ⇒ 走 exe 内嵌图标）
    path.join(app.getAppPath(), "build", name),
    // dev（本模块自己的落位）：dist-electron/../build = 仓库根/build —— 修「appPath=入口脚本目录」
    path.resolve(__dirname, "..", "build", name),
    // execPath 上溯（dev: node_modules/electron/dist/electron.exe → 仓库根 / electron 子目录）
    path.resolve(path.dirname(process.execPath), "..", "..", "..", "..", "build", name),
    path.resolve(path.dirname(process.execPath), "..", "..", "..", "build", name),
    // 进程 cwd（从仓库根启动时命中）
    path.join(process.cwd(), "build", name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 窗口/任务栏图标：Windows 必须用 .ico（PNG 会被 electron.exe 默认图标顶掉），其余平台用 png。 */
export function resolveWindowIcon(): string | null {
  return findBuildAsset(process.platform === "win32" ? "icon.ico" : "icon.png");
}
