# Codex Harness Cloud

把「界面」和「干活的身子」拆开：**界面资源放云端**（改界面 = 重新部署，用户刷新即最新，不用重装），
**数据与执行留本机**（文件、凭据、会话、记忆都在用户电脑上，云端碰不到）。

```
浏览器                       本机伴生服务 local-agent            引擎
┌──────────────┐  HTTP/SSE  ┌────────────────────────┐  stdio  ┌───────────────┐
│ 界面（云端加载）│ ─────────► │ handshake/rpc/events   │ ──────► │ codex app-    │
│ 127.0.0.1 打开 │ ◄───────── │ 配对鉴权 · 白名单       │ ◄────── │ server        │
└──────────────┘            └────────────────────────┘         └───────────────┘
      ▲                              │ 读写的都是本机
      └── 资产来自 https://ppz123.asia/cloud/（不可达则回落本地副本）
```

## 快速开始

```bash
cd cloud

npm run start:mock     # 演示模式：假引擎，不需要模型 key，看界面用
npm run start          # 真引擎：需要本机有 codex 引擎（找不到时用 HARNESS_CODEX_BINARY 指定）
```

启动后控制台会打印一个**配对码**和一条带 `?pair=` 的链接，用浏览器打开即完成配对。
（配对码 5 分钟有效、一次性；过期后服务会自动续一个新的并重新打印。）

### 两个入口，都能用

| 入口 | 地址 | 说明 |
|---|---|---|
| **云端**（推荐，记这一个就行） | `https://ppz123.asia/cloud/` | 直接敲网址。页面会**自动探测**本机 `127.0.0.1:8917` |
| 本机 | `http://127.0.0.1:8917/` | 由伴生服务下发，同源、最省事（控制台会打印） |

两个入口的**界面是同一份文件**（云端那份原样托管，本机那份由服务端多注入一行"云端在哪"）。
没找到本机伴生服务时，云端入口会给一张**说清楚怎么启动**的卡片，而不是一直转圈。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run start` / `start:mock` | 起本地伴生服务（真引擎 / 假引擎） |
| `npm run smoke` | 端到端自测（假引擎，走完整协议 + 断言），**改完必跑** |
| `npm run schema` | 从引擎自产协议 schema（`.schema/`，自测的**独立参照物**） |
| `npm run shot` | 界面走查：拉起服务 + 无头渲染逐步操作 + 截图（产物在 `docs/shots/`） |
| `npm run deploy:web` | 把 `web/` 发到云端（这一步就是"更新免重装"的全部动作） |

## 配置

都走环境变量（也可写进 `~/.codex-harness-cloud/config.json`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARNESS_CLOUD_HOME` | `~/.codex-harness-cloud` | 配置与 token 落点（**与桌面版完全分开**） |
| `HARNESS_CLOUD_PORT` | `8917` | 监听端口（只绑 `127.0.0.1`） |
| `HARNESS_CLOUD_CDN` | `https://ppz123.asia/cloud` | 界面资源地址。**换界面只改这里 + 重新部署资产** |
| `HARNESS_CODEX_BINARY` | 自动探测 | 引擎二进制路径 |
| `CODEX_HOME` | `~/.codex` | 引擎的 home 目录（**目录必须已存在**，见下） |
| `MOCK_ENGINE_STEP_MS` | `260` | 假引擎每步间隔（演示/截图调速用） |

## 协议

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `GET /` | — | 应用外壳（`no-store`）。**同一份文件云端托管的和本机下发的是同一个**：它自己算"资产从哪来、本机服务在哪"，服务端只多注入一行 `window.__CHC_CDN__` |
| `GET /api/handshake` | — | 版本、引擎状态、能力集、`cdnBase` |
| `POST /api/pair` | 配对码 | 码换 token（一次性） |
| `POST /api/rpc` | token | `{method, params}`，**只放行白名单**的 6 个方法 |
| `GET /api/events` | token | SSE 事件流（`Last-Event-ID` 可补发断流那段） |
| `POST /api/respond` | token | 回包给引擎（审批 / 询问 / elicitation） |
| `GET /api/health` | — | 存活与引擎状态 |

RPC 白名单（**白名单而非黑名单**：这套协议一改就可能多出写文件/执行命令这类高危方法，
黑名单会把新方法静默放行）：`thread/list`、`thread/start`、`thread/resume`、
`thread/unsubscribe`、`turn/start`、`turn/interrupt`。

## 安全模型（B 端要过的那几条）

伴生服务监听 `127.0.0.1`，但**本机回环对任何网页都是可达的** —— 用户浏览器打开任意
第三方网站，那个网站的 JS 就能向 `http://127.0.0.1:8917` 发请求。所以四道闸，缺一不可：

1. **凭据走 `Authorization` 头，不用 Cookie** —— 第三方请求不会自动携带；SameSite 只管 Cookie，对 fetch 无用。
2. **状态变更必须带自定义头 `x-harness-client`** —— 带自定义头 = 非简单请求 = 浏览器**强制**先发 CORS 预检。
   这是唯一能挡住"第三方页面直接 POST"的机制（无头 POST 属于简单请求，不触发预检）。
3. **Origin 精确白名单** —— 不能用 `startsWith`：`http://127.0.0.1:8917.evil.com` 会被前缀匹配放行。
4. **配对码一次性 + 5 分钟 TTL + 最多 10 次尝试 + 常量时间比较**。

另外：token / 配对码**绝不写日志**（日志可能被用户贴出来求助），自测里有一条断言专门盯这个。

## 云端部署

资源发到 `/var/www/codex-harness-cloud/`（独立目录，**不放进 release-site 的 public/** ——
那边的部署脚本用 `rsync --delete`，共用目录会在它发版时把这边删掉），Caddy 加：

```
ppz123.asia, www.ppz123.asia {
	handle_path /cloud/* {
		header Access-Control-Allow-Origin "*"      # ⛔ 必须有，见下
		root * /var/www/codex-harness-cloud
		file_server
	}
	# …原有配置不动（/v1/*、/models、forward_auth 一行都没碰）
}
```

⛔ **`Access-Control-Allow-Origin` 不是可选项**：浏览器对 ES module 一律按 CORS 模式抓取，
跨源加载 `app.js` 缺这个头会被直接拦掉（实测报 `blocked by CORS policy`）。
缺了也不会白屏 —— 外壳探测 `version.json` 失败会自动整份回落本地副本，界面照常可用、只是不自动更新。

发布：`npm run deploy:web`（脚本会自己验证公网三项：HTTP 码 / CORS / MIME）。

## 已知边界（别以为是 bug）

- **不代理模型调用**：引擎直接跟模型厂商说话，本服务只是把界面接进来。
- **不做附件/图片**：MVP 只支持文本（协议里 `capabilities.attachments = false`）。
- **只呈现一部分事件**：`tokenUsage` / `diff` / `plan` 等暂不渲染（`app.js` 的 `reduce()` 里显式列出）。
- **单机单用户**：没有多租户、没有云端会话索引 —— 那是"方案 B（云端工作区）"的事，本目录不做。
- **引擎工具面只在 spawn 时定死**（`session_meta.dynamic_tools`，`resume`/`fork` 里的 `dynamicTools` 引擎整份忽略）：
  本服务**不注册动态工具**，所以用的是引擎内置工具面。要扩工具面得改 rollout 首行再重启引擎。

## 踩过的坑（都是实测，别重复踩）

| 症状 | 真因 |
|---|---|
| 打开云端网址**一直停在"正在连接本地伴生服务…"** | 外壳里写着 `__CDN_BASE__` 之类的占位符，而**只有本机服务端会替换**；云端原样托管就没得换 ⇒ 探测必然失败。⇒ **能被云端原样托管的文件必须自己就能跑**；服务端只能"注入可选覆盖项"，不能当唯一拼装方 |
| 同上，而且**永远不报错** | 首屏没有超时。任何"探测/加载"都必须带超时并把话说清楚，否则失败就是永久转圈 |
| 云端入口打开一切正常，但**怎么都连不上本机** | Chrome 的**私有网络访问预检**：云端页面连 `127.0.0.1` 会先发 `OPTIONS` + `Access-Control-Request-Private-Network: true`，服务端必须回 `Access-Control-Allow-Private-Network: true` |
| 引擎起不来，只报"退出码 1" | 引擎要求 `CODEX_HOME` **目录已存在**，它自己不会创建 |
| 页面无样式、布局全塌，控制台只有一条跨源 `cssRules` 不可读 | 依赖 `<link>` 的 `error` 事件回落不可靠（404 返回 JSON 时不触发）⇒ 选址必须**前置探测** |
| 界面偶发被初始化两遍（两套 DOM、两条事件流） | 云端回落有两条触发路径（onerror + 超时）都会插脚本 ⇒ 要幂等 + 二次初始化守卫 |
| **前几条事件正常、之后随机丢事件** | SSE 帧推进量写成 `index + frame.length + sep`（`index` 本就等于 `frame.length`）⇒ 每次多跳一整帧；坏帧又被静默吞掉 |
| 单条事件处理抛异常后，事件流永久停更 | `reduce()` 是同步调用，抛异常会让读循环的 promise 落进 catch ⇒ 必须就地兜住单事件异常 |
| 询问卡选项多选点不动 | 回包形状必须是**两层** `{answers:{<qid>:{answers:[...]}}}`（协议 schema），写成一维数组引擎读不到 |
| 走查台起不来、exit=127 且零输出 | Electron 在 Windows 上 **stdout/stderr 不接管道**（日志必须落盘）；且**命令行多一个参数就会大概率启动失败** ⇒ 配置一律走环境变量 |
| 截图里侧栏明明该收起却还在 | 用 `transform` 收起依赖合成器时序，截图会读到未完成的布局 ⇒ 改 `display:none` |
