/**
 * updates-ipc（09-22 从 main.ts 拆域；10-03 插件化；10-11 云助手自动更新）
 *
 * 域：**应用更新链**——检查 / 下载 / 定位 / 安装 + **后台静默检查**与**状态机**。
 *
 * ── 10-11 云助手自动更新（用户需求：进度反馈 / 后台静默检查 / 下载与安装）────────
 *  ① 状态机（本域单一真相源）：idle → checking → available → downloading → downloaded
 *     → installing → done / error。每次相位变化都 `sender.send("updates:state", …)` 推给
 *     渲染层（无头形态经 headless 的 wc.send 包装自动转 SSE 广播给浏览器）。
 *  ② 后台静默检查：启动后 30s 首查（避开开机高峰），之后每 6h 一次；失败按 5min → 15min
 *     → 1h → 6h **退避**，断网（net.isOnline === false）直接跳过不打扰。
 *  ③ 下载：进度事件带**已下载/总量/速度/剩余**（updates.ts 内 3s 滑窗算速率，样本不足
 *     给 0/null，不给假数字）；支持**取消**（AbortSignal）与 `.part` 断点续传。
 *  ④ 安装：仍只接受"刚刚校验通过的那个文件"（09-13 审计 P0 口径不动）；新增
 *     **稍后安装**（记住已校验文件，下次启动提示）与**跳过此版本**（同版本不再提示）。
 *  ⑤ 产品线隔离：助手只认 `cloud-v*` + `CodexHarnessAssistant-*`（updates.ts 内分流），
 *     与桌面版 `v*` 互不串——同仓两条产品线的最大串味点。
 *
 * 跨域符号（checkLatestUpdate / downloadUpdate / installUpdate / defaultDownloadDir /
 * fileExists / UPDATE_CHANNEL / isAssistantRuntime）直接来自 ./updates，零跨域耦合。
 */
import { app, net, powerMonitor, shell } from "electron";
import fs from "node:fs";
import { stat as statAsync, rename as renameAsync } from "node:fs/promises";
import path from "node:path";
import { defineFeature } from "../context";
import type { IpcHost } from "../ipc-host";
import {
  checkLatestUpdate,
  defaultDownloadDir,
  downloadUpdate,
  fileExists,
  installUpdate,
  isAssistantRuntime,
  UPDATE_CHANNEL,
} from "../updates";

/** handler 里用到的发送端形状（⛔ 不写 any：只需要 sender.send 这一个能力）。 */
type UpdateSender = { sender: { send(channel: string, payload: unknown): void } };

const UPDATE_CHANNELS = [
  "updates:check", "updates:download", "updates:reveal", "updates:install",
  "updates:check-silent", "updates:state-read", "updates:cancel-download",
  "updates:defer-install", "updates:skip-version",
];

/** 相位（单一真相源：渲染层只按这个渲染，不要自己推断）。 */
type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "done" | "error";
type UpdateState = {
  phase: UpdatePhase;
  version?: string;
  filename?: string;
  changelog?: string;
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  error?: string;
  /** 稍后安装：已校验文件路径 + 版本（下次启动提示）。 */
  deferredVersion?: string;
  /** 当前是否在电池供电（安装会中断，UI 应提示插电）。 */
  onBattery?: boolean;
};

/** 后台检查节奏（10-11 用户定：静默、低打扰）。 */
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, CHECK_INTERVAL_MS];

export const updatesFeature = defineFeature<null>({
  id: "updates",
  inject: ["ipc"],
  setup: (ctx) => {
    const ipcHost = ctx.get<IpcHost>("ipc");
    if (!ipcHost) throw new Error("updates: 缺少 ipc 服务（宿主未提供）");

    // ★ 更新链的主进程侧权威（09-13 审计 P0）：下载地址与安装路径**不再由渲染层决定**。
    let lastUpdateInfo: { downloadUrl?: string; sha256?: string; version?: string; filename?: string } | null = null;
    let lastVerifiedUpdatePath = "";
    let state: UpdateState = { phase: "idle", percent: 0, receivedBytes: 0, totalBytes: 0, speedBytesPerSec: 0, etaSeconds: null };
    let downloadAbort: AbortController | null = null;
    /** 进度事件节流：>=2% 或 >=300ms 推一次（高频 IPC 会刷屏渲染层）。 */
    let lastPush = { pct: -1, at: 0 };
    let backoffIndex = 0;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;

    /** 持久化（跳过版本 / 稍后安装 / 上次检查时间）——放 userData，卸载域时随闭包消失。 */
    const stateFile = () => path.join(app.getPath("userData"), "updates-state.json");
    type Persisted = { skippedVersion?: string; deferredPath?: string; deferredVersion?: string; lastCheckAt?: number };
    const readPersisted = (): Persisted => {
      try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Persisted; } catch { return {}; }
    };
    const writePersisted = (next: Persisted) => {
      try { fs.writeFileSync(stateFile(), JSON.stringify(next, null, 2), { mode: 0o600 }); } catch { /* 不影响主流程 */ }
    };

    /** 相位推进 + 广播（同时保留最近状态供 state-read 拉取）。 */
    const setState = (patch: Partial<UpdateState>, sender?: UpdateSender) => {
      const onBattery = powerMonitor.isOnBatteryPower?.() ?? false;
      state = { ...state, ...patch, onBattery };
      const payload = { ...state, product: isAssistantRuntime() ? "assistant" : "desktop", channel: isAssistantRuntime() ? "assistant" : UPDATE_CHANNEL };
      try { sender?.sender.send("updates:state", payload); } catch { /* 窗口可能已销毁 */ }
      return payload;
    };

    /** 后台静默检查：失败退避、断网跳过、下载中不并发。 */
    const scheduleCheck = (delayMs: number) => {
      if (checkTimer) clearTimeout(checkTimer);
      checkTimer = setTimeout(() => { void runSilentCheck(); }, delayMs);
    };
    const runSilentCheck = async () => {
      // 下载中不并发检查（会覆盖 lastUpdateInfo 的下载地址）
      if (state.phase === "downloading") { scheduleCheck(CHECK_INTERVAL_MS); return; }
      // 断网直接跳过：不弹错、不退避（网络恢复后按常规节奏再查）
      if (net.isOnline && !net.isOnline()) { scheduleCheck(15 * 60_000); return; }
      setState({ phase: "checking" });
      try {
        const info = await checkLatestUpdate(String(app.getVersion() || "0.0.0"), process.platform, process.arch);
        const persisted = readPersisted();
        if (info?.hasUpdate && info.version && persisted.skippedVersion === info.version) {
          setState({ phase: "idle", version: info.version, changelog: info.changelog });
        } else {
          lastUpdateInfo = info ? { downloadUrl: (info as any).downloadUrl, sha256: (info as any).sha256, version: info.version, filename: info.filename } : null;
          setState({
            phase: info?.hasUpdate ? "available" : "idle",
            version: info?.version,
            filename: info?.filename,
            changelog: info?.changelog,
            percent: 0, receivedBytes: 0, totalBytes: (info as any).size ?? 0, speedBytesPerSec: 0, etaSeconds: null,
            error: undefined,
          });
        }
        backoffIndex = 0;
        scheduleCheck(CHECK_INTERVAL_MS);
      } catch (error) {
        // 静默失败：只落状态不打扰用户，按退避重试
        setState({ phase: "idle", error: (error as Error).message });
        backoffIndex = Math.min(backoffIndex + 1, BACKOFF_STEPS_MS.length - 1);
        scheduleCheck(BACKOFF_STEPS_MS[backoffIndex]);
      }
    };

    // 启动后台静默检查（30s 后首查，之后按节奏；卸载时清 timer）
    scheduleCheck(FIRST_CHECK_DELAY_MS);

    ipcHost.handle("updates:check", async (event: unknown) => {
      const sender = event as UpdateSender;
      try {
        const currentVersion = String(app.getVersion() || "0.0.0");
        setState({ phase: "checking" }, sender);
        const info = await checkLatestUpdate(currentVersion, process.platform, process.arch);
        lastUpdateInfo = info ? { downloadUrl: (info as any).downloadUrl, sha256: (info as any).sha256, version: info.version, filename: info.filename } : null;
        const payload = setState({
          phase: info?.hasUpdate ? "available" : "idle",
          version: info?.version, filename: info?.filename, changelog: info?.changelog,
          totalBytes: (info as any).size ?? 0, percent: 0, receivedBytes: 0, speedBytesPerSec: 0, etaSeconds: null, error: undefined,
        }, sender);
        return { ok: true, info, currentVersion, channel: payload.channel, source: "github" as const };
      } catch (err: any) {
        setState({ phase: "error", error: err?.message || String(err) }, sender);
        return { ok: false, error: err?.message || String(err) };
      }
    });

    // 静默检查（UI 的"检查更新"按钮走这条：不弹错误提示、失败只落状态）
    ipcHost.handle("updates:check-silent", async () => {
      await runSilentCheck();
      return { ok: true, state };
    });

    ipcHost.handle("updates:state-read", async () => ({ ok: true, state }));

    ipcHost.handle("updates:download", async (event: unknown, input: { downloadUrl?: string; filename?: string }) => {
      const sender = event as UpdateSender;
      try {
        const url = lastUpdateInfo?.downloadUrl || input?.downloadUrl;
        if (!url) return { ok: false, error: "没有可用的更新地址（请先检查更新）" };
        const dir = defaultDownloadDir(app.getPath("downloads"));
        const safeName = String(input?.filename || lastUpdateInfo?.filename || "codex-harness-update.bin").replace(/[\\/:*?"<>|]/g, "_");
        const dest = path.join(dir, safeName);
        // ⛔ .part 断点续传：中途取消/断网不丢已下的部分，下次同版本续传（Range）。
        const partPath = `${dest}.part`;
        const resumeFrom = fileExists(partPath) ? (await statAsync(partPath)).size : 0;
        downloadAbort?.abort();
        downloadAbort = new AbortController();
        setState({ phase: "downloading", version: lastUpdateInfo?.version, filename: safeName, percent: 0, receivedBytes: resumeFrom, speedBytesPerSec: 0, etaSeconds: null, error: undefined }, sender);
        lastPush = { pct: -1, at: 0 };
        const info = await downloadUpdate(url, partPath, (progress) => {
          const pct = Math.round(progress.percent * 100);
          const now = Date.now();
          if (pct !== lastPush.pct && (pct - lastPush.pct >= 2 || pct >= 100 || now - lastPush.at >= 300)) {
            lastPush = { pct, at: now };
            setState({
              phase: "downloading",
              percent: progress.percent,
              receivedBytes: progress.receivedBytes,
              totalBytes: progress.totalBytes || state.totalBytes,
              speedBytesPerSec: progress.speedBytesPerSec ?? 0,
              etaSeconds: progress.etaSeconds ?? null,
            }, sender);
          }
        }, lastUpdateInfo?.sha256, downloadAbort.signal, resumeFrom);
        await renameAsync(partPath, info.path).catch(() => undefined);
        lastVerifiedUpdatePath = info.path;   // 只有校验通过才会走到这里
        setState({ phase: "downloaded", version: lastUpdateInfo?.version, filename: safeName, percent: 1, receivedBytes: info.bytes, speedBytesPerSec: 0, etaSeconds: 0 }, sender);
        return { ok: true, path: info.path, bytes: info.bytes };
      } catch (err: any) {
        const cancelled = /取消/.test(String(err?.message ?? ""));
        setState({ phase: cancelled ? "available" : "error", error: cancelled ? undefined : err?.message || String(err) }, sender);
        return { ok: false, error: err?.message || String(err), cancelled };
      } finally {
        downloadAbort = null;
      }
    });

    ipcHost.handle("updates:cancel-download", async () => {
      downloadAbort?.abort();
      downloadAbort = null;
      setState({ phase: "available", percent: 0, speedBytesPerSec: 0, etaSeconds: null, error: undefined });
      return { ok: true };
    });

    // 稍后安装：记住已校验文件与版本，下次启动（available 之前）提示一次
    ipcHost.handle("updates:defer-install", async () => {
      if (!lastVerifiedUpdatePath || !fileExists(lastVerifiedUpdatePath)) return { ok: false, error: "no_verified_update" };
      const next = { ...readPersisted(), deferredPath: lastVerifiedUpdatePath, deferredVersion: lastUpdateInfo?.version };
      writePersisted(next);
      setState({ phase: "available", deferredVersion: next.deferredVersion });
      return { ok: true, ...next };
    });

    ipcHost.handle("updates:skip-version", async (_event, version: string) => {
      const clean = String(version ?? "").trim();
      if (!clean) return { ok: false, error: "缺少版本号" };
      writePersisted({ ...readPersisted(), skippedVersion: clean });
      setState({ phase: "idle", version: clean });
      return { ok: true, skippedVersion: clean };
    });

    ipcHost.handle("updates:reveal", async (_event, filePath: string) => {
      // ⛔ 隐私加固（09-19 审计中危）：只允许定位「刚下载并通过 sha256 校验的那个安装包」。
      if (!lastVerifiedUpdatePath) return { ok: false, error: "no_verified_update" };
      if (path.resolve(String(filePath ?? "")) !== path.resolve(lastVerifiedUpdatePath)) return { ok: false, error: "path_not_verified" };
      shell.showItemInFolder(lastVerifiedUpdatePath);
      return { ok: true };
    });

    // 下载完成后运行安装包：交给系统默认程序打开（Windows 下即启动安装向导）
    // ⛔ 只接受**刚刚下载并通过 sha256 校验的那个文件**（09-13 审计 P0）。
    ipcHost.handle("updates:install", async (event: unknown, filePath: string) => {
      const sender = event as UpdateSender;
      if (!lastVerifiedUpdatePath) return { ok: false, error: "no_verified_update" };
      if (path.resolve(String(filePath ?? "")) !== path.resolve(lastVerifiedUpdatePath)) {
        return { ok: false, error: "path_not_verified" };
      }
      if (!fileExists(lastVerifiedUpdatePath)) return { ok: false, error: "file_not_found" };
      setState({ phase: "installing" }, sender);
      const started = await installUpdate(lastVerifiedUpdatePath);
      if (started) {
        // 安装已启动：清掉稍后安装记录（下次启动是新版本了）
        const next = { ...readPersisted() };
        delete next.deferredPath; delete next.deferredVersion;
        writePersisted(next);
      }
      return { ok: started, error: started ? undefined : "open_failed" };
    });

    ctx.effect(() => {
      if (checkTimer) clearTimeout(checkTimer);
      downloadAbort?.abort();
      for (const channel of UPDATE_CHANNELS) ipcHost.removeHandler(channel);
    });
  },
});