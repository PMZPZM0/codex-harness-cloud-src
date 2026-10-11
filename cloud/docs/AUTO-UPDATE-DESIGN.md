# 云助手自动更新 · 设计与实现说明（10-11）

> 适用范围：**云助手（Codex Harness Assistant）**。桌面版共用同一套代码，行为除「更新源」外完全一致。

## 0. 为什么要做（用户原始需求）

| 需求 | 落地形态 |
|---|---|
| ① 下载进度反馈（百分比、已下载/总量、速度、剩余、完成通知） | `updates.ts` 进度回调扩到 6 个字段；3 秒滑窗算速率；状态机每次变化推 `updates:state` |
| ② 后台静默检查更新（显示版本号+更新说明+更新入口） | 启动后 30s 首查 + 每 6h；失败退避 5m→15m→1h→6h；断网跳过；命中新版本弹**非阻塞** toast |
| ③ 下载与安装（确认后下载 → 提示重启安装；进度状态；可稍后安装、可取消） | `downloading → downloaded → installing` 三相位 + 取消（AbortSignal）+ 稍后安装（记住已校验包）+ 跳过此版本 |

## 1. 整体流程

```
启动 ──30s──▶ runSilentCheck() ──▶ 检查命中？
                                    │否 → 6h 后再查（静默）
                                    ▼是
                              phase=available ──▶ 推 updates:state ──▶ 界面 toast（非阻塞）
                                    │
                    ┌───────────────┴───────────────┐
                立即更新                          跳过此版本（持久化，同版本不再提示）
                    ▼
        updates:download（.part 断点续传 + sha256 校验）
                    │ 进度：percent / 已下载 / 总量 / 速度 / 剩余
                    ├── 取消 ──▶ AbortController 中断，.part 保留（下次 Range 续传）
                    ▼
        phase=downloaded ──▶ 立即重启安装 │ 稍后安装（记 userData/updates-state.json）
                    ▼
        updates:install（只认刚校验通过的文件）→ 安装器启动 → 应用退出 → 新版启动
```

## 2. 模块划分（各层职责单一）

| 层 | 文件 | 职责 |
|---|---|---|
| 网络/校验 | `electron/updates.ts` | 版本解析比较、`checkAssistantUpdate`（助手线）、下载（进度/取消/续传/校验）、安装 |
| 编排/状态 | `electron/features/updates-ipc.ts` | 状态机唯一真相源、后台调度与退避、断点/跳过/稍后安装持久化、9 条 IPC 通道 |
| 桥 | `electron/preload.ts` | 生成段（5 条新通道）+ 手写桥 `onUpdateState`（事件） |
| 界面 | `part02c2`（订阅与动作）+ `01-sidebar-shell`（账号菜单 → 检查更新子页）+ `17-visual-cards.css`（进度条） | 只渲染相位与数字，不自己推断 |

## 3. 状态管理（单一真相源在主进程）

```
idle ──check──▶ checking ──▶ available ──download──▶ downloading ──完成──▶ downloaded ──install──▶ installing
  ▲                  │失败→error                     │取消→available                    │
  └──────────────────┴───────────────────────────────┴──────────────────────────────────┘
```
- 状态对象：`{phase, version, filename, changelog, percent, receivedBytes, totalBytes, speedBytesPerSec, etaSeconds, error, deferredVersion, onBattery, product, channel}`
- 推送：`sender.send("updates:state", …)`；无头形态经 headless 的 `wc.send` 包装自动转 SSE 广播给浏览器
- 读取：启动时 `updates:state-read` 拉一次快照（覆盖"应用启动时已有待安装包"）
- 界面严格按 `phase` 渲染；旧字段（updateInfo/updateProgress）保留兼容

## 4. 异常与边界（逐条对应用户提的"网络中断/校验失败/用户取消/低电量"）

| 场景 | 处理 |
|---|---|
| 网络中断/超时 | 三档镜像序（gh-proxy → ghfast → 直连）逐个试；全挂则静默失败并**退避重试**，不弹错误打扰用户 |
| 断网 | `net.isOnline() === false` 直接跳过本轮，15 分钟后再试 |
| 校验失败（sha256 不符） | 删除已下文件 + 报错「已删除下载文件」，用户可重试（不会装上坏包） |
| 用户取消 | `AbortController` 中断请求与写流；`.part` 保留；再次下载同版本时 `Range: bytes=N-` 续传（服务端不支持则自动整包重下） |
| 低电量 | 状态里带 `onBattery`（`powerMonitor.isOnBatteryPower`），界面在"已下载待安装"时提示插电；不自动重启 |
| 安装器被占用 | 安装包 `preInit` 先强杀运行中的旧实例（托盘应用关不掉的老坑，已修） |
| 版本线串味 | 助手只认 `cloud-v*` + `CodexHarnessAssistant-*`；桌面版只认 `v*` + `Codex.Harness.Desktop-*` |

## 5. 改动文件清单

- `electron/updates.ts`：镜像序接入；`isAssistantRuntime()`；`checkAssistantUpdate()`；下载加 `signal`/`startByte`/速度与 ETA
- `electron/features/updates-ipc.ts`：状态机 + 后台调度 + 5 条新通道（check-silent / state-read / cancel-download / defer-install / skip-version）
- `electron/preload.ts`：`onUpdateState` 手写桥
- `src/vite-env.d.ts`：手写桥类型声明
- `src/features/app-state/parts/bag-types.ts`：`updateState` 与三个动作进 Bag
- `src/features/app-state/parts/part02/03-thread-switch-update/02-update-ui-settings.tsx`：订阅快照与事件、三个动作
- `src/features/app-view/AppView/01-sidebar-shell.tsx`：状态机驱动的更新面板（进度条/速度/剩余/取消/稍后/跳过/重试）
- `src/styles/17-visual-cards.css`：进度条与提示样式
- `electron/ipc-channels.manifest.json` / `electron/ipc-registry.ts` / `src/lib/extensibility-catalog.mjs`：通道登记（463 → 468）

## 6. 实测结论（10-11）

- `updates:state-read` → `phase: idle, version 0.0.1`
- `updates:check` → **`channel: "assistant"`、`up_to_date`**，不再把桌面版 v0.0.38 当成助手更新 ✅
- ⚠️ 开发态 `app.getVersion()` 返回 Electron 版本（44.2.0），打包后为真实产品版本（extraMetadata 钉的 0.0.1）——判读更新相关返回时注意