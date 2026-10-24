# 团队项目记忆与知识库：工具契约与规范（2026-10-23）

> 配套 `TEAM-COLLAB-DESIGN.md`。本文回答六件事：团队项目记忆怎么记、团队知识库怎么记、
> 个人记忆/知识库是什么、个人与团队怎么区分与排优先级、怎么开通与配置、开通后 Codex 工具怎么变。
>
> **架构前提（10-23 用户澄清）**：客户机上**已部署腾讯记忆空间（MemHub）与腾讯知识库（WeKnora）**。
> ⇒ 团队能力**不自建存储**：云端只做「建空间 + 发凭据 + 验成员权限」，内容读写由成员的 Codex 工具直连。

---

## 1. 团队项目记忆的共享记录规范

### 1.1 存储归属
| 项 | 值 |
|---|---|
| 存储介质 | **MemHub 团队空间**（一个团队一个 MemHub user，`team-<teamId>`） |
| 隔离键 | 团队专属 `userKey`（如 `sk-mem-…`）+ `memUserId`（如 `usr-…`） |
| 共享原理 | **同一把 userKey = 同一空间**；成员之间不各建空间，都拿团队这把 |
| 云端职责 | 建空间、发凭据（`/teams/:id/integrations`）、校验成员身份；**不落内容** |

### 1.2 记录规范（写团队记忆时）
| 字段 | 规范 |
|---|---|
| `scope` | 必填 `team`（不带 scope 默认 personal，见 §4） |
| `teamId` | 必填；以当前团队上下文为准，跨团队写入必须显式指定 |
| 内容 | **一条一个事实**：可复用的结论/约定/决策，不写过程流水；单条 ≤ 2000 字（管理员可调 `maxEntryChars`） |
| 必备要素 | 结论 + 依据（谁/何时/为什么），缺依据的结论标 `待确认` |
| 禁止 | 个人隐私、账号密码、客户敏感数据；**个人记忆内容不得复制进团队** |
| 冲突处理 | 与既有团队记忆冲突时**不覆盖**：追加一条并标 `supersedes:<旧条目id>`，由 owner/admin 裁决合并 |
| 署名 | 自动带写入者账号（MemHub 侧 user），不可伪造 |

### 1.3 读规范
- 成员默认**可读全部团队记忆**；写入者只可修改/删除自己写的条目，owner/admin 可管理全部。
- 团队记忆**不进个人检索结果**的默认范围（见 §4 优先级）。

---

## 2. 团队知识库的记录规范

### 2.1 存储归属
| 项 | 值 |
|---|---|
| 存储介质 | **WeKnora 团队知识库**（库名 `t-<teamId>`，如 `t-TMVL1K8VTGMRQ`） |
| 检索通道 | 团队专属 **MCP 端点**（`/mcp/<endpointId>` + `mcpToken`），下发给成员 |
| 云端职责 | 建库、建只读检索端点、代理检索（`POST /teams/:id/kb/search`）、校验成员身份 |
| 写入通道 | **客户端上传**（WeKnora 的写知识走文件上传，云端不代写文本）→ P1 |

### 2.2 记录规范（往团队库放资料时）
| 项 | 规范 |
|---|---|
| 粒度 | 一份文档一个主题；同名多版用 `v2` 后缀，不覆盖历史（可追溯） |
| 必备元信息 | 标题、来源（内部文档/链接/会议纪要）、生效日期、负责人 |
| 格式 | 优先 `.md`；扫描件需 OCR 后再入库（WeKnora 侧配置视觉模型后支持图片） |
| 禁止 | 含密钥/凭据的文件、个人隐私数据、未脱敏的客户数据 |
| 命名 | `<领域>-<主题>-<日期>`，领域取团队约定的枚举（如 `api` / `ops` / `product`） |
| 生命周期 | 过期资料标 `[已失效]` 而非直接删；owner/admin 每季度清理一次 |

### 2.3 检索规范
- 成员在云端可直接检索：`POST /teams/:id/kb/search {query}`（代理 WeKnora，返回 title/snippet/score）；
- 本机 Codex 可用团队 MCP 端点做**带上下文的深度检索**（search_knowledge / grep_chunks / read_document）；
- 团队库检索**不混入个人库**（不同 kbId，天然隔离）。

---

## 3. 个人知识库与个人记忆库：定义与存储范围

| 维度 | 个人知识库 | 个人记忆库 |
|---|---|---|
| 定义 | **当前账号私有的文档库**，只有本人可读写检索 | **当前账号私有的记忆层**，存个人偏好、会话结论、项目上下文 |
| 存储 | WeKnora 库 `u-<username>`（如 `u-admin`），kbId 存在 `db.integrations[username].kbId` | MemHub 个人 user（`chc-<username>`），`memKey` / `memUserId` 存在同一槽位 |
| 访问通道 | 个人 MCP 端点（`/mcp/<endpointId>`） | MemHub 个人 key（`X-Tdai-User-Key`） |
| 开通条件 | 个人权益 `knowledge` 有效（订阅/激活） | 个人权益 `memory` 有效 |
| 范围 | **只属于该 username**；团队、其他账号、管理员检索都看不到内容（管理员只能看到"是否已建库/建空间"） | 同左 |
| 容量 | 个人权益的 quotaMb | 个人权益的 quotaMb |

**关键边界**：个人库与个人记忆**永不进入**团队检索结果；反之亦然。跨层复制必须由用户显式操作（复制 = 用户自己的决定，不是系统的默认行为）。

---

## 4. 个人与团队的调用区分与优先级规则

### 4.1 显式 scope（工具参数）
```
memory_write(scope="personal" | "team", teamId?, text, tags?)
memory_search(query, scope="personal" | "team" | "auto", teamId?, limit?)
knowledge_add(scope=..., ...)      # 团队 KB 写入 P1（走客户端上传）
knowledge_search(query, scope=..., limit?)
```

### 4.2 默认值（无 scope 时）
| 场景 | 默认 scope | 理由 |
|---|---|---|
| 会话处于某个团队上下文（客户端已绑定 teamId） | **team** | 在团队项目里干活，写下来的意图是共享 |
| 会话无团队上下文 | **personal** | 单人使用，避免误污染团队空间 |
| 检索 | **auto** | 见 4.3 |

### 4.3 auto 检索的优先级与合并
```
1) 显式 scope=personal/team  ⇒ 只查该层，不合并（最快、最可预测）
2) scope=auto（默认）
   a. 团队层检索（若已绑定团队且团队能力已开通）
   b. 个人层检索
   c. 合并去重（同 title+首 80 字视为同条）
   d. 排序：团队命中 优先于 个人（团队=项目共识，个人=我的上下文）
      同层内按 score 降序
   e. 返回条目标注来源：source: "team" | "personal"
3) 团队能力未开通 / 非团队成员 ⇒ **跳过团队层，不报错**（静默降级到个人）
```
**为什么团队优先**：团队库/记忆是"项目事实"（接口约定、部署方式），答错代价高；个人记忆是"我的偏好"，冲突时应服从项目共识。

### 4.4 硬性隔离
- 团队层结果**只对团队成员可见**（非成员即使拿到 query 也返回 403，不会静默空结果）；
- 个人层结果**永不出现在团队聚合视图**；
- 管理员没有"读内容"的后门（只能看到空间是否已建、条目数与容量）。

---

## 5. 开通条件与配置项

### 5.1 团队能力的开通条件（三层，全部满足才可用）
| 层 | 条件 | 谁配置 |
|---|---|---|
| ① 平台级 | `db.teamPolicy.enabled = true`（团队功能总开关） | 管理员：`POST /admin/team-policy` |
| ② 能力级 | `memoryEnabled` / `kbEnabled` 分别开关；`freeSeats`（免费席位）；`maxEntryChars` | 同上 |
| ③ 团队级 | 团队已 `provision`（团队 WeKnora 库 + MCP 端点 + MemHub 团队空间已建） | 团队 owner/admin：`POST /teams/:id/provision` |

> 个人订阅**不影响**团队能力；团队套餐（P1）到位前，用 `freeSeats` 提供免费档。

### 5.2 配置项清单
| 键 | 默认 | 含义 |
|---|---|---|
| `teamPolicy.enabled` | true | 团队功能总开关（关 = 不能建团队、成员全部降级） |
| `teamPolicy.freeSeats` | 3 | 免费档席位数（团队创建时的 seatLimit） |
| `teamPolicy.memoryEnabled` | true | 团队记忆开关（关 = 团队记忆接口 403） |
| `teamPolicy.kbEnabled` | true | 团队知识库开关 |
| `teamPolicy.maxEntryChars` | 2000 | 单条团队记忆长度上限 |
| `team.settings.allowMemberInvite` | false | 成员能否自行邀请 |
| `team.settings.memoryWriteMode` | `all` | `all` / `contributor-only`（仅本人条目可改） |

### 5.3 已实测的开通链路（客户机线上）
```
POST /teams/TMVL1K8VTGMRQ/provision
→ kb:      { kbId: aa4b77d0-…, kbName: t-TMVL1K8VTGMRQ, mcpUrl: …:8080/mcp/586e6bb3-…, mcpToken: mcp_… }
→ memory:  { userKey: sk-mem-M95D…, memUserId: usr-nf5sfvtkek, baseUrl: …:8096/claude-code/default/v1 }
GET /teams/:id/integrations  → owner 与 member 拿到**同一份**团队凭据（共享成立）
GET /teams/:id/integrations  → 非成员 403 not-a-member（隔离成立）
POST /teams/:id/kb/search    → { backend: "weknora", hits: [] }（真库 200）
关闭 memoryEnabled 后        → 403 team-memory-disabled（降级成立）
```

---

## 6. 启用后 Codex 工具的变化（功能 / 调用方式 / 行为）

### 6.1 功能变化
| 工具 | 启用前 | 启用后 |
|---|---|---|
| `memory_write` | 只能写个人记忆 | 多出 `scope="team"`：写入团队共享空间（需 teamId，云端验成员） |
| `memory_search` | 只查个人 | `scope="auto"` 时合并团队层并标注来源；`scope="team"` 只查团队 |
| `knowledge_search` | 只查个人库 | 多出团队库（团队 MCP 端点 / 云端代理），`auto` 时团队优先 |
| `knowledge_add` | 写个人库 | P1：`scope="team"` 走团队库上传（当前团队库由 owner 在网页端上传） |
| 新增（P1） | — | `team_list` / `team_current`：让模型知道"现在在哪个团队、成员是谁、能力是否就绪" |

### 6.2 调用方式变化
- **参数**：`scope` + 可选 `teamId`；无 scope 时按 §4.2 默认（有团队上下文 → team）。
- **凭据**：客户端从 `/teams/:id/integrations` 取（团队 MCP 端点 token / MemHub 团队 key），
  **与个人凭据分开存**（`userData/team-integrations.json`），切换团队时替换而不是覆盖。
- **失败语义**（重要）：
  - 非成员 / 未开通 ⇒ 团队层**跳过并标注**，不让整个检索失败；
  - 团队空间未 provision ⇒ 返回 `team-not-provisioned`，提示"请团队管理员先在网页端开通"。

### 6.3 行为变化（对模型的可见影响）
| 行为 | 启用前 | 启用后 |
|---|---|---|
| 写入默认去向 | 个人 | **有团队上下文时写团队**（模型必须在回复里说明"已写入团队记忆"） |
| 检索结果排序 | 个人内 score | 团队优先，个人补充，每条标 `source` |
| 冲突处理 | 无 | 团队事实优先于个人偏好；个人与团队冲突时**提示用户**，不自行覆盖 |
| 跨团队 | 不存在 | 一次会话只绑定一个团队；切换需用户显式操作，模型不得自行切 |
| 隐私 | — | 团队层不返回任何个人条目；个人层不返回任何团队条目 |

### 6.4 工具契约（实现基准，P1 落地到桌面端）
```ts
memory_write({
  scope: "personal" | "team",
  teamId?: string,          // scope=team 必填（无则用当前团队上下文）
  text: string,             // ≤ maxEntryChars
  tags?: string[],
  supersedes?: string,      // 与旧条目冲突时引用旧 id
})

memory_search({
  query: string,
  scope?: "auto" | "personal" | "team",   // 默认 auto
  teamId?: string,
  limit?: number,                          // 默认 8
})
// 返回：[{ source: "team" | "personal", text, score, at, author? }]

knowledge_search({ query, scope?, teamId?, limit? })
// 返回：[{ source, title, snippet, score }]

knowledge_add({ scope, teamId?, title, text, tags })   // P1：team 走上传
```

---

## 7. 实测记录（客户机线上，2026-10-23 22:0x）

| 用例 | 结果 |
|---|---|
| 建团队「Codex 项目组」 | `TMVL1K8VTGMRQ` ✓ |
| 生成团队邀请码 → invited02 加入 | `{"ok":true,"role":"member"}` ✓ |
| provision（真建空间） | WeKnora 库 `t-TMVL1K8VTGMRQ` + MCP 端点 + MemHub 团队空间 `usr-nf5sfvtkek` ✓ |
| owner 取凭据 | 团队库/MCP/记忆 key 齐全 ✓ |
| 成员取凭据 | **与 owner 同一份**（共享）✓ |
| 非成员取凭据 | 403 not-a-member（隔离）✓ |
| 团队 KB 检索代理 | `{backend:"weknora", hits:[]}` 200（空库正确）✓ |
| 关闭 memoryEnabled | 团队记忆接口 403 team-memory-disabled（降级）✓ |
| 席位 | 2/3（owner + 1 成员）✓ |

**本轮自查发现并修复的问题**
1. 🔴 路由顺序：`/teams/:id/integrations` 被 `/teams/:id` 详情路由先吞 ⇒ 判成非成员（已加排除）。
2. 🔴 方向错误：最初用云端自建 JSON 存储团队记忆/KB ⇒ 与"客户机已部署腾讯服务"冲突，已改为**真对接 WeKnora + MemHub**，并删除自建存储与死代码。
3. 🟡 团队 KB 写入：WeKnora 无「写文本」HTTP 接口（写知识走文件上传）⇒ 本轮不代写，标 P1（客户端上传 / 云端 multipart 转发）。
4. 🟡 团队记忆读写：MemHub 的读写由客户端 MCP 直连，云端只有 `meta/user/*`（建用户/发 key）⇒ 云端**不代理记忆内容**，只发凭据 + 指路。

## 8. 待办（P1）

| 项 | 说明 |
|---|---|
| 桌面端工具加 `scope` 参数 | 三仓同步（主仓 / PPcode / 云助手），按 §6.4 契约实现 |
| 团队凭据存储 | 客户端 `userData/team-integrations.json`，切换团队时替换 |
| 团队 KB 写入 | 云端 multipart 转发到 WeKnora（复用个人 `/kb/upload` 的实现），或直接客户端上传 |
| 团队套餐 | 席位/容量/赠积分计价 → 复用易支付链路（`kind=team-plan`） |
| 团队管理后台 | 管理端「团队管理」页：全站团队、席位、空间就绪状态、强制解散 |
| 团队记忆审计 | MemHub 团队空间按成员统计贡献（需 MemHub 侧支持） |

---

## 9. 实现状态（2026-10-23 · v1.5.93）

- 服务端契约**已实现并线上实测**：`/teams/:id/{provision,integrations,memory,kb/search,kb/upload,kb/docs,kb/delete,points}`、`/team-plans*`、`/admin/team-*`。
- **实测结果**（客户机 38.145，真实 MemHub + WeKnora）：团队库 `t-TMVL1K8VTGMRQ` 建成 → 上传 markdown → `parse_status=completed` → 检索命中（score 0.995）→ 团队记忆 key 可取且**对外地址可访问** → 非成员 403 → 关能力后 403 降级。
- 凭据一律下发**对外地址**（`kbUiBase` / `memory.publicBase`），不再出现 `127.0.0.1`（这是本节最重要的修正：早期实现下发内网地址，成员机器必然连不上）。
- 桌面端 `scope` 参数仍为 **P1 未实施**；当前成员用「云端下发的团队凭据」在本机 Codex 侧配置即可工作。

---

## 10. 桌面端落地（2026-10-24 · 主仓 `0f0169a`）

> 本节只留指针 —— **代码不在本仓**（本仓是云端服务 + 云端界面，没有桌面端云账号设置页）。

桌面端的接法**不是** §6.4 的「给 memory_write 加 scope 参数」，而是**通道切换**
（`electron/features/team-mode.ts`，域 id `team`）：

- 进入团队 = 对话上游切到团队 `userKey`（记忆在请求层自动注入/写入；MemHub 无 CRUD，造不出 write/search 工具）
- 团队知识库 = 接成 `cloud-kb-team` 连接器（与个人 `cloud-kb` 互斥：WeKnora 工具名相同）
- 退出 = 清记忆上游 + 停团队连接器 + 按原状态恢复个人库

详细约束与未做项见主仓 `docs/TEAM-MEMORY-KB-TOOL-CONTRACT.md` §10。
⛔ 本仓不参与该功能（无 settings-cloud 域），改动只有两条守卫判据的同步。
