# 配对门设计方案：把「网页账号」变成配对的前置条件

| 项 | 值 |
|---|---|
| 状态 | **提案（未实施）** |
| 范围 | `cloud/`（云助手仓独有目录，桌面版 / PPcode 两仓没有 `cloud/` ⇒ 无需三仓同步） |
| 依据 | 逐文件实测（`local-agent/*`、`web/*`、`server-account/*`、`README.md`），非推测 |
| 目标 | 用户**先在网页注册账号**，才允许与某台电脑的助手配对 |

---

## 一、角色与组件

| 角色 | 实体 | 位置 | 凭据 |
|---|---|---|---|
| **站长服务** | `server-account/server.js`（端口 8091，Caddy `/cloud-api/*` 反代） | 站长服务器 | 账号密码 + 会话 token（服务端存 sha256，7 天） |
| **网页入口** | `https://ppz123.asia/cloud/`（`web/index.html` 的 `connector` 模式） | 云端静态托管 | 账号会话 token |
| **本机伴生服务** | `local-agent/server.js`（`127.0.0.1:8917`，只绑回环） | 用户电脑 | 配对码 → 本机 token |
| **本机界面** | 同一份 `web/index.html`，但被服务端注入 `__CHC_MODE__="full"` | 用户电脑 | 本机 token（localStorage `chc-token`） |
| **桌面助手 / 机主** | `CodexHarnessCloud.exe` 的控制台 | 用户电脑 | 控制台打印的 owner 码 |

⛔ 关键事实：**网页与账号服务只管"网站身份"；本机服务与配对码只管"连通性"；两者目前零连接**
（`grep -rn "cloud-api|8091|accounts" cloud/local-agent/` → **无任何命中**）。

---

## 二、现有流程（完整逻辑）

### 2.1 两个入口

| 入口 | 地址 | 走的闸 |
|---|---|---|
| 云端 | `https://ppz123.asia/cloud/` | `MODE="connector"` ⇒ **账号 → 找本机助手 → 个人配对码**（`index.html` 的 `runConnector()`） |
| 本机 | `http://127.0.0.1:8917/` | `MODE="full"` ⇒ **直接挂完整界面**（`app.js`），**整段跳过登录门** |

`local-agent/server.js` 的 `shellHtml()` 对 `GET /` **无条件**注入 `window.__CHC_MODE__ = "full"`，
`GET /` 没有任何鉴权。⇒ 同一份界面文件，**两条完全不同的准入路径**。

⛔ **网页侧这条链已经是"账号优先"，而且已被走查验证过**：`cloud/.shot-home/gate-e2e.cjs` 断言
"本机助手没开时**也先显示账号卡**（可注册）→ 注册成功后才是「启动助手」引导"，
产物 `docs/shots/gate-e2e-01-account-first.png` / `-02-assistant-gate.png` 已入库。
⇒ 本方案的"绕过"**不在网页侧，而只在本机入口**，这一点先说清楚，免得改错地方。

### 2.2 三种凭据（澄清"两种码"）

| 凭据 | 谁生成 | 在哪显示 | TTL | 可重复用？ | 换到什么 |
|---|---|---|---|---|---|
| **owner 一次性开机码** | 本机 `Pairing.issue()`（`auth.js`） | **本机控制台**（启动横幅）+ 打印 `?pair=` 链接并**自动开浏览器** | 5 分钟 | ❌ 一次性（成功即作废） | **owner token**（`cfg.token`） |
| **个人配对码（用户码）** | 本机 `UserRegistry.add()`，由机主 `--add-user 名字` 签发 | 签发那一刻的控制台 | **长期** | ✅ 可反复配对 | **该用户自己的固定 token** |
| **账号会话 token** | 站长服务 `/register` `/login` | 网页 localStorage `chc-session` | 7 天 | ✅（会话内） | 仅用于访问**网页本身**；**本机不认它** |

⛔⛔ **不存在"网页配对码"**。三种凭据里**前两种都由本机生成**，第三种是网站身份且**与配对链路不相通**。
用户设想的"本地码 vs 网页码"，实际是"本机生成的两码" ＋ "网页账号（另一套，不相通）"。

### 2.3 数据流（现状）

```
【本机路径 —— 绕过网页账号】
控制台打印 base/?pair=<owner码>  →  自动开浏览器
   └→ GET /              （无鉴权，注入 MODE=full）
   └→ app.js 读到 ?pair= → 自动 POST /api/pair {code}
        └→ 本机 auth.js 比对 owner 码 → 返回 cfg.token
   └→ 进完整界面。  ⛔ 全程未访问 ppz123.asia、未注册账号

【网页路径 —— 账号前置（已经是对的）】
浏览器 → ppz123.asia/cloud/
   └→ runConnector(): GET /cloud-api/me
        ├─ 无会话 → 渲染注册/登录表单 → POST /cloud-api/register|login
        └─ 有会话 → afterAccount()
              └→ 探测 127.0.0.1:8917（GET /api/health）
              └→ 渲染"个人配对码"输入 → POST 本机 /api/pair {code}
                    └→ 302 到 本机 /#t=<token>（fragment，不进日志）
```

`/api/pair` 的校验（`local-agent/server.js:267`）：Origin 白名单 + `x-harness-client: web` 自定义头 +
**先试 owner 码、再试用户码**。`/api/rpc`、`/api/events`、`/api/respond` 要 Bearer token。

---

## 三、当前设计中不合理 / 自相矛盾之处

1. **🔴 两个入口的安全语义不对等（这就是"绕过"本身）**
   云端入口强制"账号 + 配对"；本机入口因 `MODE=full` 完全跳过登录门。
   同一份界面文件、同一台机器，**准入门槛取决于从哪个 URL 进**。
2. **🔴 账号在配对准入链路上没有任何权威**
   账号被**停用**（`server-account` 的 `disabled`）不影响任何已签发的本机码与 token ——
   两边数据完全不通。账号既不能授予、也不能撤销"连上某台电脑"的资格。
3. **🔴 owner 码就地自举，连码都不用输**
   `openBrowser(base + "/?pair=" + pairing.code)` ⇒ 双击应用即自动兑换 owner token。
   这是最短的绕过路径，也是"用户期望的注册前置"**最直接的反例**。
4. **🟠 真源分裂：两个"用户名"**
   本机 `users.json` 的 `name`（机主线下命名）与账号服务的 `username`（用户自己注册）
   是**两套互不相关的身份**，却都叫"用户"。`handshake.account.userId` 返回的是**本机名字**，
   不是账号 —— 将来要按账号做云存储隔离（README 已预留 `cloudStorage`）时，这个错位会直接变成数据串户风险。
5. **🟠 账号服务的能力与它的用途不匹配**
   README 自述账号只用于"访问管理与防滥用"；而用户期望它是**准入闸**。这是**口径冲突**，
   不是实现 bug —— 但按现在的代码，无论账号是否存在、是否停用，都拦不住配对。
6. **🟠 授权模型是"机主线下发码"**
   机主可以给任意人发用户码，站长（账号服务）不知道；反过来账号服务也无法限制机主给谁发码。
   多用户只是"本机多行记录"，不是"多租户"。
7. **🟡 部署缺口**
   `scripts/deploy-web.sh` 只发 `/cloud/*`；`/cloud-api/*` → 8091 的反代、账号服务的启动方式、
   `data.json` 落点与备份，仓库里**没有 runbook**（只在 README 里一句"Caddy 反代到 127.0.0.1:8091"）。
8. **🟡 命名歧义**
   README 的「两个入口、两种身份」容易被读成"两套等价凭据"。实际是"一套连通性凭据（本地生成）"
   ＋ "一套网站身份（不相通）"。共享同一个词"配对码"，是误解的源头。

---

## 四、调整后的流程方案（账号前置）

### 4.1 核心原则

> **账号是配对的准入前提，票据是两者之间唯一的连接件；本机必须能独立向账号服务核销，而不是"网页说登录了就信"。**

理由：网页代码完全由用户控制（改 localStorage、直接 curl 本机 `/api/pair` 都行），
**任何"由网页转述的账号状态"都不可信**。可信的做法只有一条：账号服务签发一个一次性票据，
**本机拿票据反向找账号服务核销**。

### 4.2 新流程步骤

```
① 注册/登录（新增前置，网页）
   浏览器 → GET /cloud-api/me → 无会话 ⇒ 注册/登录表单
   POST /cloud-api/register | /login  →  账号会话 token（复用现有实现）

② 取配对票据（新增）
   POST /cloud-api/pair-ticket    （Bearer 账号会话）
   → { ticket, expiresAt }        ticket = 32B 随机，服务端只存 sha256
   ⛔ 一次性、TTL ≤ 2 分钟、绑定 username

③ 找本机助手（现有）
   探测 127.0.0.1:8917 /api/health

④ 配对（改：多带一个 ticket）
   POST 本机 /api/pair { code: <个人配对码>, ticket: <②的票据> }
   本机侧顺序：
     a. 现有三道闸（Origin / 自定义头 / 常量时间比对）
     b. **先核销 ticket**：POST /cloud-api/pair-ticket/verify { ticket }
          → { ok, username } | { ok:false, reason: expired|used|account-disabled|unknown }
        ⛔ 核销失败 ⇒ 直接拒，**不进入码比对**（避免用错误信息探测本机码是否存在）
     c. 再试 owner 码（**仅本机 owner 通道**，见 4.4）
     d. 再试用户个人码 ⇒ 命中后把 token 与 **username** 绑定（不再是本机 name）

⑤ 交接（现有）
   302 → 本机 /#t=<token>（fragment 不进日志）→ 收下即 replaceState 抹掉
```

### 4.3 各环节配对码/票据的用途（调整后）

| 环节 | 凭据 | 生成方 | 作用 | 与之前的变化 |
|---|---|---|---|---|
| ① | 账号会话 token | 站长服务 | 证明"你是本站注册用户" | 不变 |
| ② | **配对票据 `ticket`** | 站长服务 | **把账号身份授权给一次配对动作**；本机凭它核销 | **新增** |
| ④ | 个人配对码 | 本机（机主签发） | 证明"你有权连这台机器" | **改为必须与 ticket 同时提交** |
| ④ | owner 一次性开机码 | 本机控制台 | 机主本人自助（本机物理可达） | **收窄**：不再是页面自动兑换，见 4.4 |

### 4.4 owner 通道怎么处理（必须显式决策）

**建议保留 owner 免 ticket，但改变它的暴露方式**，理由：站长自己断网/服务器挂了也得能进自己的机器；
且 owner 的信任根本来就是"能碰到这台机器 + 能看到控制台"，与账号无关。

- **去掉** `openBrowser(base + "/?pair=" + code)` 这条"双击即自动登入"的路径
  （它让"本机入口"看起来完全不需要任何凭据）；
- owner 码改为**必须手动输入**（或至少要显式点一次"以机主身份进入"），
  且 UI 上明确写"这是机主通道，不需要账号；给他人用请让对方去网页注册后拿个人码"。

### 4.5 涉及的角色与数据流（调整后）

```
用户浏览器 ──①注册/登录──► 站长服务(8091)
    │                         │ 签发 ticket（一次性/TTL≤2min/绑 username）
    │◄──②ticket───────────────┘
    │
    ├──③探测─────────────────► 本机伴生服务(127.0.0.1:8917)
    └──④POST /api/pair{code,ticket}──►
                                     └──核销 ticket──► 站长服务 /pair-ticket/verify
                                                        │ { username } 或拒绝原因
                                     ◄──────────────────┘
                                     └─ 通过 ⇒ 签发 token（token ⇄ username 绑定）
    ◄──⑤ /#t=<token> ────────────────┘
```

**新增数据面**：
- 站长服务：`tickets: { <sha256(ticket)>: { username, exp, usedAt } }`（沿用现有 `db.sessions` 的风格，内存 + 落盘）
- 本机服务：token ⇄ `username` 映射（放进 `users.json` 或新的 `bindings.json`）；
  **与账号相关的只有 username，不落任何账号资料**
- 本机 → 站长服务的**服务间调用**需要一条认证：建议本机启动时用一次"注册机主设备"
  换取一个长期的服务凭据（否则任何人都能调 `/pair-ticket/verify` 探测票据有效性）

### 4.6 需要改动的部分（逐文件）

| # | 文件 | 改动 | 必/可 |
|---|---|---|---|
| 1 | `cloud/server-account/server.js` | 新增 `POST /pair-ticket`（签发）、`POST /pair-ticket/verify`（核销，**要求服务凭据**）、`GET /pair-ticket/status?username=`（供吊销轮询）；票据表 + 清理 | 必 |
| 2 | `cloud/local-agent/server.js` | `/api/pair` 接收 `ticket`；新增账号服务地址配置与核销调用；**先核销后比对码**；`matchToken` 的返回值由"本机 name"改为 `username`；`/api/handshake` 的 `account.userId` 改为真实 `username` | 必 |
| 3 | `cloud/local-agent/config.js` | 增 `accountsBaseUrl` / `deviceCredential`（服务间凭据） | 必 |
| 4 | `cloud/local-agent/auth.js` | `UserRegistry` 记录增加 `username` 绑定字段；`--add-user` 增加可选的"绑定到账号"参数 | 必 |
| 5 | `cloud/web/index.html` | 配对步改为"先取 ticket 再提交"；错误码分档（`ticket-expired` / `account-disabled` / `ticket-used` / `mismatch`）—— 现在只有 mismatch/expired/locked 三档，分不清"码错"还是"账号不行" | 必 |
| 6 | `cloud/web/app.js`（full 模式） | 去掉 `?pair=` 自动兑换（4.4）；无 token 时的配对卡文案区分"机主通道 / 用户通道" | 必 |
| 7 | `cloud/README.md` | 改写「登录与多用户」（账号=准入前提）；安全模型补第 5 条（ticket 层）；「已知边界」把"单机单用户"改成准确描述 | 必 |
| 8 | `cloud/scripts/deploy-web.sh` + README | 补 `/cloud-api/*` 反代、账号服务启动方式、`data.json` 落点与备份 | 必 |
| 9 | `cloud/scripts/smoke.mjs` | **现有自测已覆盖**码机制（错码拒绝 / owner 码一次性 / **重放无效** / 用户码换到 `userId` 身份 / 匿名 handshake 不带身份 / 令牌与码不进日志）；**缺的是账号准入这一层** ⇒ 补断言：无 ticket 不能配对 / ticket 重放无效 / 账号停用后不能配对 | 必 |
| 10 | 迁移脚本 | `users.json` 存量用户码 → 绑定账号（或给宽限期 + 强制一次性重绑） | 必 |

### 4.7 风险与取舍（必须由你拍板的三条）

1. **可用性被绑到站长服务器**：断网 / 服务器挂 / 证书过期 ⇒ **用户进不去自己的电脑**。
   必须显式选择降级策略：
   - (a) 严格（推荐做默认）：核销失败即拒，只提示"账号服务不可达"；
   - (b) 宽限：本机缓存最近一次成功核销（例如 24h），期内允许离线配对；
   - (c) owner 通道（4.4）作为有意的兜底。
2. **隐私口径变化**：账号服务从"只存身份"变成**准入权威** —— 仍不存用户内容，
   但会知道"谁、什么时候、在哪台设备上配对过"。README 需要如实写出来。
3. **存量用户**：已有个人码的人升级后会被挡在门外。要么强制重新绑定账号（推荐，一次性），
   要么给一段宽限期并在 UI 上倒计时提示。

---

## 五、一句话总结

**现在的"注册"是网页自己的门，配对是另一扇门，两扇门之间没有墙。**
本方案在中间加一道**由账号服务签发、由本机反向核销的一次性票据**，
让"注册账号"从**网站仪式**变成**配对的前置条件**；同时明确保留一条**机主本机通道**
（否则可用性完全依赖站长服务器），并把这条通道从"自动登入"收紧为"显式选择"。
