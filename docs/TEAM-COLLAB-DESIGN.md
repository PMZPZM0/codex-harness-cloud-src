# 团队协作体系设计（2026-10-23）

> 目标：在现有「个人账号 + 积分 + 权益订阅」之上，加一层**真人组织协作**能力：
> 团队模式、团队记忆空间、团队知识库、团队管理、团队套餐。
> 本文档只定义**边界与关系**，不约束实现细节；落地按 §6 分期。

---

## 0. 先划清一个易混概念

| 名称 | 是什么 | 不是什么 |
|---|---|---|
| **团队（Team）** | 云管理里的**多账号组织单元**：一个 owner + 若干成员，共享记忆空间、知识库与套餐额度 | ⛔ 不是桌面版的「专家团 / agentteam」——那是 AI 智能体角色协作，与本体系无关 |
| **个人账号** | 现有 `db.users`（一人一号，积分、权益、个人订阅都挂在它身上） | 团队不替代个人账号，个人数据永远只属于个人 |
| **团队套餐** | 以**团队**为购买主体（按席位 + 容量 + 赠积分计价） | 不是个人套餐的团购；两者并存、各自结算 |

**一句话边界**：个人账号管"我是谁、我有什么"，团队管"我们共享什么、谁可以动"。

---

## 1. 总体结构

```
个人账号(users) ──1:N──> 团队成员关系(teamMembers) ──N:1──> 团队(teams)
        │                        │                              │
        │                        │ 角色：owner / admin / member  │
        │                        ▼                              ▼
   个人积分·个人订阅·个人权益   读写权限/邀请权/配额          团队套餐(席位+容量+积分池)
   （与团队完全隔离）                                          ├─ 团队知识库（独立实例）
                                                              ├─ 团队记忆空间（team 作用域）
                                                              └─ 团队积分池（共享消耗）
```

三条硬规则：

1. **数据隔离**：个人视图只看个人数据；团队视图只看当前团队数据；不存在"混显"。
2. **额度隔离**：个人套餐额度与团队套餐额度**互不挪用**（团队容量只能用于团队 KB/记忆）。
3. **主体隔离**：团队套餐到期只影响团队能力（降级为只读），不影响成员的个人订阅。

---

## 2. 数据模型

### 2.1 团队主体
```js
teams[teamId] = {
  id, name, slug,              // slug 用于展示与审计，不用于鉴权
  owner,                       // username，唯一；转让即改这一项
  createdAt, status,           // active | suspended | dissolved
  planId,                      // 当前团队套餐（空 = 免费试用档）
  seatLimit,                   // 席位数上限（来自套餐，可被管理员手工覆盖）
  pointsPool,                  // 共享积分池余额（成员消耗从这里扣）
  kbQuotaMb, memQuotaMb,       // 容量上限（来自套餐）
  settings: {
    allowMemberInvite,         // 成员能否自行邀请（默认 false → 只有 admin 能邀）
    defaultRole,               // 新成员默认角色（默认 member）
    memoryWriteMode,           // all | contributor-only（默认 all）
  },
}
```

### 2.2 成员关系
```js
teamMembers[teamId][username] = {
  role,                        // owner | admin | member
  status,                      // active | left | removed
  joinedAt, invitedBy,
  quotaOverride: {             // 可选：给个别成员单独设额度（P2）
    kbQuotaMb, memQuotaMb, memSearches,
  },
}
```
- **owner 恒唯一**（转让 = 旧 owner 变 admin + 新 owner 接任，写审计）。
- 一个账号可属多个团队；UI 上通过「当前团队」上下文切换（见 §3.1）。

### 2.3 团队邀请
```js
teamInvites[code] = {
  teamId, code, createdBy, role,
  maxUses, usedCount, expiresAt, disabled,
}
```
- 与「个人邀请码」是**两套东西**：个人邀请码用于拉新注册（计奖励），团队邀请码用于拉人进团队（不计奖励）。
- 落地页 `/account.html?team=<code>`：登录后自动展示"加入 XX 团队"确认。

### 2.4 团队额度与权益（复用现有权益模型）
```js
teamEntitlements[teamId] = {
  knowledge: { enabled, expiresAt, quotaMb, usedMb, grantedAt },
  memory:    { enabled, expiresAt, quotaMb, usedMb, grantedAt },
}
```
- 结构与现有个人 `grantFeature` 完全同构 ⇒ **直接复用**权益的叠加续期 / 宽限期 / 到期清理逻辑。
- 区别只在"归属键"：个人按 username，团队按 `team:<teamId>`。

### 2.5 团队积分池流水
```js
teamPointsLedger = [{ id, teamId, at, delta, kind, ref, actor, note }]
```
- `kind`：`team-plan-bonus`（买套餐赠送）/ `consume`（团队能力消耗）/ `admin-grant`（管理员发放）/ `refund`。
- **不设"团队积分转账给个人"**（避免洗积分与对账黑洞）；团队池只能被团队能力消耗。

### 2.6 团队套餐
```js
teamPlans[planId] = {
  id, name, desc, active, sort,
  priceCny,        // 团队价（元）
  points,          // 购买赠送进**团队积分池**
  seats,           // 席位数
  days,            // 有效期
  kbQuotaMb, memQuotaMb,
}
```
- 与个人套餐（`db.plans`）**分表**：定价维度不同（席位 vs 个人），混在一张表会让两个后台互相污染。

---

## 3. 五个模块的功能边界

### 3.1 团队模式（视图切换）

| 项 | 定义 |
|---|---|
| 能力 | 顶部/侧栏「当前团队」切换器：个人 ⇄ 团队 A ⇄ 团队 B |
| 默认 | **个人**（未加入任何团队时，团队分组整体显示引导卡："创建团队 / 输入邀请码加入"） |
| 影响面 | 切换后：记忆空间、知识库、额度显示、订阅页数据范围全部跟随当前团队 |
| 不影响 | 个人积分余额、个人订阅、个人邀请奖励 —— 这些永远在个人视图 |
| 落盘 | `localStorage.chc-current-team`（仅 UI 上下文，不参与鉴权；服务端每次请求仍校验成员关系） |

**边界**：团队模式只是一个"视角 + 上下文"，不改变任何数据归属；切换不产生任何写入。

### 3.2 团队记忆空间

| 项 | 定义 |
|---|---|
| 存储 | 记忆作用域 `team:<teamId>`（现有三作用域 private/team/project 里的 team 正好对接） |
| 读 | 全体 active 成员 |
| 写 | `memoryWriteMode=all` 时全体可写；`contributor-only` 时仅 owner/admin 与自己贡献的条目可改 |
| 管理 | owner/admin：删除、合并、导出、关闭写入 |
| 额度 | 容量取 `teamEntitlements.memory.quotaMb`；检索次数按成员累计 |
| 计费 | 团队检索/写入消耗**团队积分池**（个人积分不动） |
| 与个人记忆 | **完全隔离**：个人记忆不会被团队成员看到；同一账号在团队视图下写入的记忆归团队 |

### 3.3 团队知识库

| 项 | 定义 |
|---|---|
| 存储 | 独立 KB 实例（复用现有 WeKnora 建库路径，挂 `teamId` 而不是 username） |
| 读 | 全体 active 成员 |
| 写 | 上传：全体（可按 settings 收紧到 admin）；删除：owner/admin |
| 检索 | 复用现有分词/向量链路；结果只在团队视图可见 |
| 额度 | 容量取 `teamEntitlements.knowledge.quotaMb` |
| 与个人知识库 | 独立实例，**不共享索引**；个人库不进团队检索结果 |

### 3.4 团队管理

| 功能 | 权限 | 说明 |
|---|---|---|
| 创建团队 | 任意登录用户 | 创建者即 owner；免费档默认 3 席位 |
| 邀请成员 | owner/admin（或 settings 允许时成员自邀） | 生成团队邀请码/链接；席位满则拒绝 |
| 移除成员 | owner/admin | 移出后其贡献内容保留（归属标"已离队"） |
| 角色调整 | owner | owner↔admin↔member；owner 转让单独动作 |
| 席位与配额 | owner（管理员可覆盖） | 席位来自套餐；成员配额 P2 支持单独设置 |
| 解散团队 | owner（管理员可强解） | 二次确认 + 数据保留 30 天只读 |
| 审计 | owner/admin 可看 | 邀请/移除/角色/配额/套餐变更留痕 |

### 3.5 团队套餐

| 项 | 定义 |
|---|---|
| 购买主体 | 团队（owner 下单，团队积分池/线下收款） |
| 定价维度 | 席位 + 知识库容量 + 记忆容量 + 赠送积分 |
| 支付 | 复用现有易支付链路：订单 `kind=team-plan`，回调 → `activateTeamPlan` |
| 到期 | 宽限期（与个人一致 3 天）→ 降级只读（成员可读不可写，不能邀请） |
| 升级/降配 | 升级立即生效（按剩余天数折算）；降配到期生效（不立刻踢人） |
| 与个人套餐 | 完全独立结算；一个账号可以同时有个人套餐与所在团队的团队套餐 |

---

## 4. 左侧菜单层级（落地结构）

```
【个人】
  产品首页
  用户中心
  订阅中心
  邀请好友
  配对中心
  云端管理
  记忆空间
  知识库

【团队】                      ← 新增分组；无团队时整组显示引导卡
  团队概览                    ← 当前团队切换器 + 席位/容量/到期/成员数
  团队记忆空间
  团队知识库
  团队成员                    ← 仅 owner/admin 可见
  团队设置                    ← 仅 owner/admin：名称/套餐/配额/邀请策略/解散

【管理员】                    ← 已按要求去掉「中心」二字
  用户管理
  模型管理
  记忆空间管理
  知识库管理
  WorkBuddy Manager
  订阅与充值
  邀请管理
  团队管理                    ← 新增：全站团队列表 / 席位与套餐 / 强制解散 / 审计
```

命名规范（后续新增项一律遵守）：
- **管理员组不带「中心」**（用户要求，已执行：用户管理 / 模型管理 / 记忆空间管理 / 知识库管理）。
- 用户可见的能力组保持名词短语（`订阅中心`、`配对中心` 保留 —— 它们属于"个人"组，不在本次调整范围）。
- 团队组统一以「团队」开头，与个人组同名项区分（记忆空间 / 团队记忆空间）。

---

## 5. 接口草案（供实现阶段对齐）

```
# 团队
POST   /teams                       创建（name）
GET    /teams                       我加入的团队列表（含角色/席位/到期）
GET    /teams/:id                   概览（成员数、席位、容量用量、状态）
PATCH  /teams/:id                   名称/设置（owner）
POST   /teams/:id/dissolve          解散（owner，二次确认）

# 成员
GET    /teams/:id/members           成员列表（role/status/joinedAt）
POST   /teams/:id/invites           生成团队邀请码（role/maxUses/expiresInDays）
POST   /teams/join                  用邀请码加入
PATCH  /teams/:id/members/:user     改角色/移除（owner）
POST   /teams/:id/transfer          转让 owner

# 团队能力
GET    /teams/:id/entitlements      KB/记忆额度与到期
GET    /teams/:id/points            团队积分池余额 + 最近流水

# 团队套餐
GET    /team-plans                  套餐列表
POST   /team-plans/buy              下单（owner）
POST   /admin/team-plans/grant      管理员手动开通（无支付渠道时兜底）
GET    /admin/teams                 全站团队（管理员）
```

鉴权统一走现有 `accountWho()` + **成员角色校验**（`teamRoleOf(teamId, username)`），不新造身份体系。

---

## 6. 实施分期

| 期 | 范围 | 判据 |
|---|---|---|
| **P0** | 数据模型 + 团队创建/加入/成员/角色 + 团队记忆空间 + 团队知识库 + 团队菜单与视图切换 | 两个账号可协作：A 建团队拉 B，B 在团队视图写入记忆/上传 KB，A 能看到；个人数据不受影响 |
| **P1** | 团队套餐（定价/支付/开通/到期降级）+ 团队积分池与消耗 | owner 买到团队套餐 → 席位与容量生效；到期只读；池内积分可被团队能力消耗 |
| **P2** | 成员配额细分、审计报表、跨团队协作（一个账号多团队切换体验打磨） | owner 可给单个成员设独立额度；审计可导出 |

**P0 不改个人链路**（个人订阅/积分/邀请/配对全部原样）；团队是并行新增的一层，避免回归风险。

---

## 7. 与现有能力的复用清单（避免重复造）

| 需求 | 直接复用 |
|---|---|
| 权益叠加续期 / 宽限期 / 到期清理 | `grantFeature` 同构逻辑，只换归属键为 `team:<id>` |
| 支付下单 / 验签 / 回调 / 补单 | 现有易支付链路，订单加 `kind=team-plan` |
| 知识库建库 / 检索 / 分词 | 现有 WeKnora 通道，挂 teamId |
| 记忆作用域 | 现有 private / **team** / project 三作用域，team 作用域即团队记忆 |
| 积分扣减 / 流水幂等 | `addPoints` 的 ref 幂等模式，扩展到团队池 |
| 邀请码与关系记录 | 现有 `db.invites` / `inviteRelations` 结构，团队邀请另表但不另造校验 |
| 管理端列表与配置页 | 现有三板块（配置/列表/对账）版式，团队管理照此排 |

---

## 7.1 延伸阅读

- **团队积分与团队管理方案**：`docs/TEAM-POINTS-MGMT-DESIGN.md`
  （积分套餐 / 消耗与退分 / 余额展示 / 消耗场景 / 用户级开通闸门 / 批量管理清单与权限矩阵）
  —— 本文 §2.5（团队积分池）与 §2.6（团队套餐）的完整实现细则在那里，且**改了团队入口的可见性规则**（需管理员逐个开通）。

## 8. 实现进度（2026-10-23 · v1.5.93）

### 8.1 已完成（线上实测）

| 模块 | 落地内容 | 状态 |
|---|---|---|
| 团队主体 | `POST/GET /teams`、`GET /teams/:id`、`PATCH /teams/:id`（改名/设置）、`POST /teams/:id/dissolve`（二次确认） | ✅ |
| 成员 | 邀请码（一次性/7 天）、`POST /teams/join`、成员列表、改角色、移除、转让 owner | ✅ |
| 团队记忆 | **真对接 MemHub**：`POST /teams/:id/provision` 建团队用户空间，`GET /teams/:id/memory` 下发凭据（对外基址） | ✅ |
| 团队知识库 | **真对接 WeKnora**：建团队库 `t-<id>` + MCP 端点、`kb/search` 代理、`kb/upload`、`kb/docs`、`kb/delete` | ✅ |
| 菜单/页面 | 侧栏「团队」组（概览 / 记忆空间 / 知识库 / 成员 / 设置）+ 管理员「团队管理」 | ✅ |
| 团队套餐 | `db.teamPlans` + `/team-plans`、`/team-plans/buy`（易支付）、`/admin/team-plans[/grant]`、回调 `kind=team-plan` | ✅ |
| 团队积分池 | `db.teamPointsLedger`（ref 幂等）+ `/teams/:id/points`；套餐赠送积分入池 | ✅ |
| 邀请落地 | `/teams/:id/invite` 生成 `?team=<code>` 链接，打开即**自动加入** | ✅ |

### 8.2 与设计稿的差异（实现时定的）

1. **内容不落云端**：团队记忆/知识库的**内容**在 MemHub / WeKnora，云管理只做「建空间 / 发凭据 / 验权限 / 检索代理」。设计稿里 `teamEntitlements` 只管席位与容量，不存条目。
2. **团队 ID 形态固定**：`^T[A-Z0-9]{4,40}$`（服务端生成）。理由：ID 直接当对象键，宽松白名单会被 `__proto__` 绕过（实测会写 `Object.prototype`）。
3. **GET 不建空间**：`kb/docs|search|delete|upload` 在未开通时返回 **409 `team-kb-not-provisioned`**，开通只能由 owner/admin 显式点「开通 / 修复团队空间」。
4. **手动开通不幂等（仅积分）**：席位/容量覆盖，赠送积分每次发放（续费语义）⇒ 后台加了二次确认。

### 8.3 部署侧必须配的两项（否则成员连不上）

| 项 | 位置 | 说明 |
|---|---|---|
| 知识库对外地址 | `db.services.kb.uiBase`（云端管理 → 知识库 → 后台地址） | MCP 端点用 `<uiBase>/mcp/<id>`；客户机内部是 `127.0.0.1:8080`，直接用成员连不上 |
| 记忆对外地址 | `db.services.memory.publicBase`（云端管理 → 记忆服务 → 对外地址） | 团队记忆 baseUrl = `<publicBase>/claude-code/default/v1`；缺省回落内部地址并在页面告警 |

另：WeKnora 的**解析**依赖 embedding 模型可达。客户机发现 `EMBEDDING_BASE_URL=http://172.17.0.1:11434/v1`（直连 IP）被 SSRF 校验拒绝，导致**所有**知识库文档 `parse_status=failed`；已改为 `http://host.docker.internal:11434/v1` 并把主机加入 `SSRF_WHITELIST_EXTRA`（`.env`，改动前已备份）。此问题与团队无关，但会让团队知识库「上传成功却检索不到」。

### 8.4 未完成（P1/P2 剩余）

- **桌面端工具 `scope` 参数**：`memory_write/memory_search/knowledge_search` 加团队作用域 + 团队凭据本地存储（三仓同步，未开始）。
- 团队知识库**通过 MCP 直传**的用量不计入云端 `kbUsedMb`（云端只统计经过 `/kb/upload` 的量）。
- 团队套餐到期**降级只读**（当前只标记 expired，不限制读写）。
- 成员级配额细分、审计导出（P2）。
