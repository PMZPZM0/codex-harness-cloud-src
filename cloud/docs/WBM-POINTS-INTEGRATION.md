# 云助手 × WorkBuddy Manager 积分接入方案

> 2026-10-14 立。依据是**实测探查**（不是猜）：WBM 跑在 `wb.ppz123.asia` → `127.0.0.1:7864`，
> FastAPI 面板，代码 `/home/ubuntu/deploy`，数据 `data/manager.db`(SQLite) + `data/users.json`。

---

## 0. 先说清"两边各有什么"（决定方案可行性）

### WBM（WorkBuddy Manager）现有能力 —— 实测

| 能力 | 实际形态 | 对本方案的意义 |
|---|---|---|
| **管理面 API** | `/api/*`，会话 Cookie **或** `Authorization: Bearer wbt_…`（兼容 `X-API-Key`，值须带 `wbt_` 前缀） | ⭐ **外部集成通道已存在**，不需要改 WBM 代码就能读 |
| **作用域化 Token** | `POST /api/tokens {name, scope, expires_at}`，scope = `readonly` / `admin`，明文仅返回一次，库里只存哈希，可吊销 | 给云助手发一把 **readonly** 就能长期安全读取 |
| **按 key 的积分配额** | 表 `api_keys`：`quota_credit`（配额）+ **`used_credit`（已用积分）** | 「积分消耗」的权威计量在此 |
| **用量账本** | 表 `usage_daily` / `usage_hourly`：`day,hour,key_id,model,requests,prompt_tokens,completion_tokens,`**`credit`**`,realm` | 可按 key/模型/时段对账 |
| **账号级积分变动** | 表 `task_logs`：`uid,kind,level,`**`credits`**`,message,dedup_key`（签到/活跃/旅行等获取） | 上游余额的**来源**流水 |
| **实时上游余额** | `GET /api/accounts/{filename}/credits`（腾讯侧实时值，带 TTL 缓存与缓存年龄） | 需要"真实余额"时用它 |
| **卡密/红包** | 表 `red_packets` / `red_packet_shares`（面额、份额、模式、模型、有效期） | ⭐ 管理员"发放积分"可以走它**发放可核销的额度** |
| 用户与鉴权 | `data/users.json`：`{secret, users, api_keys}` + `/api/login`、`/api/me` | 与云助手账号体系**互不干涉** |

### 云助手侧现状

账号服务（`chc-account`，`/cloud-api/*`）：账号（PBKDF2）、设备（≤3 台）、会话同步（≤1GB）。
**目前没有任何积分概念** —— 本方案新增一套，且**与设备/容量配额互不混用**。

---

## 1. 积分体系设计（云助手内置账本）

### 1.1 数据模型（`chc-account` 的 SQLite，新增三张表）

```sql
-- 余额（派生量：= 流水累加，但单独存一份便于校验）
CREATE TABLE points_accounts (
  username   TEXT PRIMARY KEY,
  balance    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 流水（唯一真相源；ref 唯一 ⇒ 同一件事只入账一次，幂等）
CREATE TABLE points_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  delta      INTEGER NOT NULL,          -- 正=增，负=消耗
  kind       TEXT NOT NULL,             -- signup | admin_grant | consume | wbm_sync | reconcile | refund
  ref        TEXT NOT NULL UNIQUE,      -- 幂等键（见 2.3）
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_points_ledger_user ON points_ledger(username, created_at DESC);

-- 与 WBM 的同步游标（按通道各存一条）
CREATE TABLE points_sync_state (
  channel    TEXT PRIMARY KEY,          -- wbm_usage | wbm_tasklog
  cursor     TEXT,                      -- 最后处理到的 WBM 记录键
  synced_at  INTEGER
);
```

### 1.2 规则

| 场景 | 行为 | 流水 kind |
|---|---|---|
| **新用户注册** | 账本建户 + **入账 1000**（`ref=signup:<username>`，幂等 ⇒ 不可能重复送） | `signup` |
| **管理员手动加分** | 管理端按用户名加分（正负皆可，必须填备注），写一条流水 | `admin_grant` |
| 云助手里调用模型 | 按用量扣分（见 §2 的同步口径），**余额不足则拒绝发起** | `consume` |
| 与 WBM 对账 | 按 WBM 计量值修正本账本（差额一条流水，备注写明原因） | `wbm_sync` / `reconcile` |
| 退款/撤销 | 管理端冲正（写正数流水，不改历史） | `refund` |

**铁律**：`points_ledger` 是唯一真相源；`points_accounts.balance` 必须恒等于该用户流水之和
（提供一个 `verify` 自查端点，不一致就报警并重建 —— 与项目里 `logs/` 的 `verify`+`dedupe` 同思路）。

---

## 2. 数据同步方式（核心）

### 2.1 三种"同步"要先分清

| # | 方向 | 内容 | 手段 |
|---|---|---|---|
| **A** | 云助手 → 本机显示 | 用户在云助手里看到自己的余额与消耗明细 | 直读本地账本（不走网络） |
| **B** | WBM → 云助手 | 拉 WBM 计量的**消耗**（`usage_*.credit`）与账号侧**获取**（`task_logs.credits`） | 定时 pull（读 API） |
| **C** | 云助手 → WBM | 管理员发放的积分若要"真能在上游用"，走 WBM 的**卡密/红包**发放 | 写 API（需 admin scope token） |

### 2.2 拉取通道（B，方案主体）

```
云助手 points-sync（每 5 分钟 + 手动"立即同步"）
   ├ GET /api/keys                → 每个 key 的 quota_credit / used_credit（当前累计）
   ├ GET /api/task-logs?since=…   → uid 维度的 credits 变动（获取）
   └ GET /api/accounts/{f}/credits → 需要真实余额时的实时值（可选、低频）
        │  Bearer wbt_<readonly>
        ▼
   写入 points_ledger（按 2.3 的幂等键）→ 重算 balance → 对账报告
```

**授权**：在 WBM 里建一把 `readonly`（建议命名 `codex-assistant-sync`、设过期），
把 `wbt_…` 存进 `chc-account` 的环境变量（**不进代码库、不进任何同步范围**）。

### 2.3 幂等与游标（"不重复扣、不丢一条"的关键）

| 来源 | 幂等键（`points_ledger.ref`） |
|---|---|
| WBM 用量（日粒度） | `wbm:usage:<day>:<key_id>:<model>` |
| WBM 用量（小时粒度，若启用） | `wbm:usage:<day>:<hour>:<key_id>:<model>` |
| WBM 任务/账号账本 | `wbm:tasklog:<id>`（优先）或 `wbm:tasklog:<dedup_key>` |
| 云助手本地消耗 | `local:call:<本机产生的调用 id>` |
| 注册/管理发放 | `signup:<username>` / `admin:<操作 id>` |

游标 `points_sync_state.cursor` 记"最后成功处理到的记录键"，下次从这里继续；
**同一 key 重复出现只入账一次**（`ref UNIQUE` 兜底）⇒ 重放、重试、并发都安全。

### 2.4 消耗口径（"与 WBM 保持同步"的具体含义）

- **推荐终态（同源）**：云助手的模型调用**经由 WBM 网关**（`POST /v1/chat/completions`）发出，
  WBM 自己计量 `credit` ⇒ 双方**天然同一个数**，云助手只做**镜像展示**，不存在对账误差。
- **过渡态（对账）**：云助手按**与 WBM 相同的计费口径**自行计分（模型目录里的倍率 `x0.05` 一类，
  见 `services/modelcatalog.py`），再把 WBM 的计量值拉回来对账：
  - 差异 ≤ 容差（建议 1% 或 5 分）⇒ 记 `wbm_sync` 静默对齐；
  - 超出容差 ⇒ 记 `reconcile` 流水 + **管理端醒目提示**，绝不静默改数。

### 2.5 管理员发放积分（C，两种语义要分清楚）

| 发放类型 | 含义 | 实现 |
|---|---|---|
| **云助手内部积分** | 只在云助手里可用的额度 | 直接写 `admin_grant` 流水（简单、即时） |
| **上游可用额度** | 用户拿它去上游（腾讯侧）消费 | 通过 WBM 的**卡密/红包**发放（`red_packets`），用户在 WBM 侧核销 —— ⛔ 上游余额**不能凭空写**，只能靠卡密/签到等正规渠道进入 |

默认走前者；需要后者时在管理端显式选择"并发放上游卡密"。

---

## 3. 关键实现步骤（分阶段，每阶段可独立验收）

### P0 · 打通链路（半小时）
1. WBM 里创建 `readonly` token（`codex-assistant-sync`，设 90 天过期）
2. `chc-account` 加环境变量 `WBM_BASE=http://127.0.0.1:7864` + `WBM_TOKEN=wbt_…`
3. 新增 `GET /cloud-api/wbm/probe`（内部带 token 调 `/api/healthz` 与 `/api/keys`，只回摘要）
   **验收**：返回 WBM 版本 / key 数 / 累计 used_credit；token 不出现在任何响应与日志里

### P1 · 积分账本 + 注册送 1000 + 管理员加分
4. 建三张表（§1.1）；`/register` 成功后写 `signup` 流水（幂等）
5. `GET /cloud-api/points/me`（余额 + 近 50 条流水）
6. `POST /cloud-api/admin/points/grant {username, delta, note}`（admin 角色 + 审计）
7. 用户中心展示余额与明细；管理端加"发放积分"表单
   **验收**：新账号注册即 1000；同一账号重复触发注册链路不会变成 2000；管理员加分有流水与审计

### P2 · 对账同步（拉取）
8. `points-sync`：定时（5 分钟）+ 手动；按 §2.3 幂等入账；写游标
9. `GET /cloud-api/admin/points/reconcile`：给出"本地记的消耗 vs WBM 计量"差异表
10. `GET /cloud-api/points/verify`：balance == 流水之和 的自查
   **验收**：人为改一条本地流水后 `verify` 报错；WBM 侧新增一次用量后 5 分钟内出现在明细里且**只出现一次**

### P3（可选）· 同源化
11. 云助手为用户申请一把 WBM 网关 key，模型调用改走 WBM 网关 ⇒ 取消对账误差
   **验收**：同一时段双方数字**逐条相等**

---

## 4. 风险与不变量

1. ⛔ **不超过 WBM 的既定语义**：`credits` 是上游余额，**不能由云助手凭空增减**；云助手自己的积分是独立账本。
2. ⛔ **token 只读优先**：同步只要 `readonly`；任何写操作单独申请 `admin` 并限定用途。
3. ⛔ **凭据不进任何同步范围**（与既有的"凭据永不出本机"同一条）：`wbt_` 只存在服务端环境变量。
4. ⛔ **账本不可变**：只能追加流水，不能改历史；余额是派生量并随时可校验。
5. ⛔ **配额三者独立**：设备（≤3 台）· 存储（≤1GB）· 积分；任一超限都**明确拒绝并说明是哪一个**。

---

## 5. 实际落地的计费口径（2026-10-18 追记）

> 上面 §1–§4 是 10-14 的**设计稿**；实现最终没走 SQLite（`chc-account` 一直是 `data.json`），
> 也没走"与 WBM 对账"。下面是**代码里真实在跑**的口径 —— 查计费问题时以本节为准。

### 5.1 两条独立链路（⛔ 别混）

| 链路 | 算什么 | 谁在算 | 落在哪 |
|---|---|---|---|
| **WBM `request_logs.credit`** | 上游返回的**真实** `usage.credit`；缺真值时用 `_estimate_credit()` 兜底（`credit_source` 标 `upstream` / `estimated`） | `/home/ubuntu/deploy/server/routers/gateway.py` | WBM 的 SQLite（`request_logs` / `usage_daily` / `usage_hourly`） |
| **云助手积分** | `积分 = (prompt_tokens + completion_tokens) / 1000 × 模型倍率`，**保留 2 位小数** | `cloud/server-account/server.js` 代理响应采集处 | `data.json` 的 `points.<user>.txns` |

⛔⛔ **云助手**的积分**不取上游 `usage.credit`**（2026-10-14 21:5x 用户定案）—— 因为上游对收费模型也常返 0。
倍率唯一真相源 = `data.json` 的 `modelCatalog.list[].credits`（管理界面可改）。

### 5.2 「管理员改倍率会不会生效」—— 两个坑（10-18 已修）

| 现象 | 根因 | 修法 |
|---|---|---|
| 改了**当时**生效，过一会儿又变回上游值 | `pullModelCatalog()` 把 `modelCatalog.list` **整个换成上游新数组** ⇒ 管理员改的 `credits` 只在 `MODEL_SYNC_TTL_MS`（30 分钟）内有效；点一次「重新同步目录」**立刻**失效 | 同步改按 id 做**倍率保全**：每个模型记 `upstreamCredits` 快照；`creditsLocked === true` 的沿用上一份 `credits`，没锁的继续跟随上游 ⇒ 语义 = **改过=钉住，没改=跟随上游**。`POST /admin/models/credits` 的 `reset:true` = 恢复上游（用快照，不联网） |
| 倍率明明配了，某些调用却按**免费**记 | 计费用 `m.id === wantedModel` **严格相等**查目录；客户端带 `cn:` / `global:` 前缀或大小写不同 ⇒ 查不到 ⇒ `rate = 0` ⇒ 白送 | 查表前先归一化（去 `cn:`/`global:` 前缀 + 转小写），**精确优先 → 再最长子串**（最长优先是为了 `glm-5.3-flashx` 不被 `glm-5.3-flash` 抢走） |

⛔ 同类"长名 = 短名 + 后缀"的坑在 WBM 侧也有一份：`gateway.py` 的 `_model_price_per_m()`
原本把**子串价格**排在**精确倍率**之前 ⇒ `glm-5.3-flashx` 拿到 `glm-5.3-flash` 的 13.38
（应为 `500 × 0.14 = 70`）。已修为：**两层精确（价格→倍率）跑完，才进两层子串**。

### 5.3 闲时（限时）倍率（10-18 新增，管理员可改）

```js
db.offPeak = {
  enabled: false,                                  // ⛔ 默认关，不动既有计费
  windows: [
    { id: "night",   label: "夜间", start: 0,  end: 8,  rate: 0.5 },
    { id: "offpeak", label: "闲时", start: 18, end: 24, rate: 0.5 },
  ],
}
```

- **语义**：**折扣系数，乘在模型倍率之上** ⇒ `实际倍率 = 模型倍率 × 闲时系数`。
  ⛔ 它**不改**模型倍率本身（那一份仍是 `credits` 唯一真相源）。
  例：`glm-5.3` ×0.79 在夜间系数 0.5 下 ⇒ 实际 ×0.395。
- **时段判定**：服务端**本地时间**（CST）；**起点含、终点不含**（`0–8` = 00:00–07:59）；
  `start > end` = **跨零点**（如 `22 → 6`）；命中多段取**数组序在前**的那段。
- **接口**：`GET /admin/offpeak`（回显 + `active` + `serverHour`）、`POST /admin/offpeak {enabled, windows}`
  （仅管理员；`normalizeOffPeakWindows()` 做服务端二次校验：0–24、起止不等、系数 0–100，
  非法条目**丢弃**，全非法才 400）。`GET /models` 一并下发 `offPeak` 快照供客户端展示。
- **面板**：`cloud/web/account.html` 的「闲时倍率」卡（`#opCard`）——启用开关 + 时段表 + 当前命中状态；
  模型管理卡的倍率表加「已钉 / 跟随上游 / 恢复上游」。

### 5.4 计费顺序（改动计费时的检查清单）

```
鉴权（proxy token，含环内旧令牌）
  → 余额预检（≤0 直接 402，不让上游白跑）
  → 勾选校验（未勾选 403 model-not-enabled）
  → 转发上游 + 原样透传
  → 采集响应（最多 256KB）→ 抓 prompt_tokens / completion_tokens
  → 查目录倍率（归一化 → 精确 → 最长子串）
  → 积分 = tokens/1000 × 倍率 × 闲时系数，round 2
  → credit > 0 ? addPoints : addUsageOnly（免费模型只留痕不扣分）
  → persist()   ← ⛔ 10-18 补：这两个函数**只改内存不落盘**，不 persist 则本次消耗
                  要等下一次请求在鉴权处顺带写盘；期间重启/崩溃 ⇒ 该次消耗永久丢失
```

### 5.5 已知长尾（未修，已知即可）

1. 用量是从响应流**前 256KB** 里正则抓的 ⇒ 超大流式响应可能丢掉 `usage` 块 ⇒ 该次记 0（宁可少记不瞎记）。
2. 目录里查不到倍率的模型 ⇒ `rate = 0` ⇒ 按免费记（不猜、不按默认倍率兜底）。
3. `EXCLUDED_CATALOG_IDS` 目前只排除 `auto`（上游自动挑模型 ⇒ 记账无法判断实际用了哪个）。

