# 云版预留 IPC 接口设计（cloud 域，10-11）

> 通道命名 `cloud:<组>/<动作>`，与 `free-gateway:status` 等既有域同风格。
> **通道名发布即冻结：只增不改。** 设计文档：本文件；实现：`electron/features/cloud-reserve-ipc.ts`。
>
> ⛔ 预留桩统一返回形状（调用方做能力探测，不需要 try/catch）：
> `{ ok: false, reserved: true, code: "<原因>", error: "<人话>" }`
> 渲染层以 `result.reserved !== true` 判断该能力是否已开通。

## ① 数据同步（cloud:sync/*）—— 云端存储的 IPC 挂点

| 通道 | 参数 | 返回 | 状态 |
|---|---|---|---|
| `cloud:sync/status` | 无 | `{enabled, reserved, quotaBytes, usedBytes, lastSyncAt}` | ✅ 真实现（当前恒 enabled=false） |
| `cloud:sync/push` | `{paths: string[]}` | 桩：`{ok:false, reserved:true, code:"cloud-storage-not-enabled"}` | 🔒 桩 |
| `cloud:sync/pull` | `{keys: string[]}` | 同上 | 🔒 桩 |
| `cloud:sync/conflict/resolve` | `key, resolution("local"\|"cloud"\|"merge")` | 同上 | 🔒 桩 |

## ② 设备/配对管理（cloud:device/*）—— 真实现

| 通道 | 参数 | 返回 | 状态 |
|---|---|---|---|
| `cloud:device/list` | 无 | `{devices:[{name, createdAt, tokenFingerprint}]}`（指纹=token 前 6 位） | ✅ 真实现（users.json） |
| `cloud:device/unbind` | `name` | `{ok, removed, remaining}`；不存在时 throw | ✅ 真实现（解绑即 token 失效） |

## ③ 公告/通知（cloud:notify/*）

| 通道 | 参数 | 返回 | 状态 |
|---|---|---|---|
| `cloud:notify/list` | 无 | `{notices:[{id,title,body,at,read}], fetchedFromServer}` | ✅ 本地缓存真实现；服务器拉取接入后 fetchedFromServer=true |
| `cloud:notify/mark-read` | `id` | `{ok}` | ✅ 真实现 |

## ④ 助手自更新（cloud:update/*）

| 通道 | 参数 | 返回 | 状态 |
|---|---|---|---|
| `cloud:update/check` | 无 | `{available, current, latest, url, notes}` 或 `{available:false, reason}` | ✅ 真实现（探测 `/cloud/assistant/version.json`） |
| `cloud:update/download` | 无 | 桩 `code:"update-download-not-wired"` | 🔒 桩（check.url 已就位） |
| `cloud:update/apply` | 无 | 桩 `code:"update-apply-not-wired"` | 🔒 桩 |

**开通步骤**：服务器放 `/cloud/assistant/version.json`（`{version,url,notes}`）→ check 自动可用 → 接下载器（复用 free-gateway 的镜像+解压套路）→ 接 apply（替换+`app.relaunch()`）。

## ⑤ 工具链按需下载（cloud:tools/*）—— 发布形态（精简包+按需拉）的地基

| 通道 | 参数 | 返回 | 状态 |
|---|---|---|---|
| `cloud:tools/status` | 无 | `{tools:[{name,label,ready}], mode:"on-demand"}` | ✅ 真实现（探测 userData/tools） |
| `cloud:tools/download` | `name` | 桩 `code:"tool-mirror-not-configured"` | 🔒 桩（服务器 `/cloud/tools/` 分发目录就绪后接） |
| `cloud:tools/progress` | `name` | `{running, bytes, total, error}` | ✅ 真实现（当前恒 idle） |

**开通步骤**：服务器建 `/cloud/tools/<平台>/<工具>/`（国内镜像拉取后转存）→ download 复用 free-gateway 的镜像序（gh-proxy → ghfast → 直连）与进度推送 → status 的 ready 自动翻转。

## 调用方式（三端同形）

```ts
// 渲染层（桌面/浏览器真界面）：preload 已自动生成
const s = await window.codex.cloudSyncStatus();          // 无参
const r = await window.codex.cloudDeviceUnbind("tester"); // 单参
const p = await window.codex.cloudSyncConflictResolve(key, "local"); // 多参按位
if (p.reserved) { /* 能力未开通，降级 UI */ }
```

浏览器云版（登录门外壳/远端）经 441 通道桥 `POST /__ipc {channel:"cloud:sync/status", args:[]}` 同形可达（token 鉴权同全域）。

## 扩展机制（未来新增接口的固定动作序列）

1. `electron/features/cloud-reserve-ipc.ts`（或新建域文件）里 `ipcHost.handle("cloud:xxx/yyy", handler)`
2. `electron/ipc-channels.manifest.json` 追加条目（name/channel/paramsDecl/returns/invokeArgs/cast/note）—— **manifest 是桥面的真相源**
3. `npm run gen:ipc` → preload 生成段 + vite-env.d.ts 类型段 + 能力清单自动再生（新域记得在 `scripts/gen-capability-skill.mjs` 的 DOMAIN_DESCRIPTIONS 补一句描述）
4. 新域还要：`electron/composition.json` 加条目 → `node scripts/gen-domain-registry.mjs`（生成 composition.gen）→ `electron/ipc-registry.ts` 加 count 行
5. `npm run build` → 本机重启助手 → `bash cloud/scripts/deploy-app.sh` 上云（指纹变化自动触发全端刷新）

⚠️ 踩坑记录：直接改 preload 生成段会被 `gen:ipc` 吞掉（生成物勿手改，manifest 才是源）；composition.json 改完必须重跑 gen-domain-registry，否则运行时读的是旧的 composition.gen。
