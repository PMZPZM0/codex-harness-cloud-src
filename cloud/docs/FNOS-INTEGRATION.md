# 飞牛OS（fnOS）对接指南：知识库与记忆空间

> 读者：管理员本人，或**另一个 AI / 运维**。读完并按本文做完，应能在飞牛OS 上把
> 「知识库」与「记忆空间」两个上游服务跑起来，在面板里配好，并用「连通性测试」确认。
>
> 对应代码：`cloud/server-account/server.js`（账号服务）· `cloud/web/account.html`（管理面板）
> ⛔ 本文所有端点/请求头/字段名都取自**实际代码调用点**，不是推测。

## 0. 先分清职责

账号服务本身**不存**知识库内容、**不存**记忆。它只是**网关 + 权限闸**：

| 能力 | 上游服务 | 本服务怎么调它 |
|---|---|---|
| 知识库 | WeKnora（兼容其 v1 REST API） | `X-API-Key` 头；为每个账号建一个知识库 + 一个只读 MCP 检索端点 |
| 记忆空间 | MemHub（兼容其 v1 API） | `Authorization: Bearer`；建用户 + 读写记忆；**读取**走「检索代理地址」（MCP 网关） |

⇒ 你要做的是：**在飞牛OS 上把这两个服务跑起来**，然后告诉账号服务"它们在哪个地址"。

## 1. 在飞牛OS 上准备两个服务

### 1.1 通用前提

- 飞牛OS 能开容器（Docker）或装套件；两个服务各占一个**固定端口**
- 给 NAS 一个**固定的局域网 IP**（下文用 `192.168.1.10` 示例）
- **账号服务所在的机器必须能直连这两个地址**（同内网最简单）
- ⛔ 不要填 `localhost` / `127.0.0.1`：账号服务通常不在 NAS 上，回环地址指向它自己
- ⛔ 如果账号服务跑在公网服务器、NAS 在家里，需要打通（VPN / 内网穿透 / 或把账号服务也放到内网）

### 1.2 知识库（WeKnora）

本服务实际会调的端点（照这张表判断"上游是否兼容"）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/knowledge-bases?page_size=1` | 连通性探测 / 列知识库 |
| POST | `/api/v1/knowledge-bases` | 给账号建库 |
| PUT | `/api/v1/initialization/config/{kbId}` | 配 LLM / 嵌入 / 视觉模型 |
| POST | `/api/v1/mcp-endpoints` | 建只读检索端点 |
| GET | `/api/v1/knowledge-bases/{id}/knowledge` | 列文档 |
| POST | `/api/v1/knowledge-bases/{id}/knowledge/file` | 上传文档（multipart） |
| POST | `/api/v1/knowledge-search` | 检索 |
| GET | `/api/v1/knowledge/{id}/download` | 下载原文 |

**鉴权（最容易错的一处）**：`X-API-Key: <租户 API Key>`
⛔ 不是 `Authorization: Bearer` —— 后者是 JWT 的入口，拿租户 key 去走会返回
`401 invalid or expired token`（10-16 已实测踩过）。

在**账号服务那台机器**上自检：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "X-API-Key: <租户KEY>" \
  'http://192.168.1.10:8080/api/v1/knowledge-bases?page_size=1'
# 期望 200。401/403 = key 不对；超时/连接被拒 = 地址或端口不对；404 = 少了路径前缀
```

### 1.3 记忆空间（MemHub）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/meta/user/create` | 按账号名建用户 |
| 其余 | 由 MemHub 自己的 MCP 端点承担 | 检索代理（读取） |

**鉴权**：`Authorization: Bearer <API Key>`

自检（MemHub 没有公开健康端点，用"收到任何 HTTP 响应"判断存活）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.1.10:8090/
# 任何 < 500 的状态码（含 404）都说明 HTTP 栈是活的
```

## 2. 在面板上配置

`https://<你的域名>/account.html#/admin` → 卡片 **「知识库 · 记忆空间」**

| 字段 | 填什么 | 留空会怎样 |
|---|---|---|
| 知识库 · 服务地址 | `http://192.168.1.10:8080` | 回退环境变量 `WEKNORA_BASE` |
| 知识库 · 租户 API Key | WeKnora 租户 key | 回退凭据 `weknora-admin-key` / `WEKNORA_ADMIN_KEY` |
| 知识库 · LLM / 嵌入 / 视觉 模型 id | 上游模型 id（如 `qwen2.5:7b`） | 回退 `WEKNORA_LLM_MODEL_ID` / `_EMBED_` / `_VLM_` |
| 记忆 · 服务地址 | `http://192.168.1.10:8090` | 回退 `MEMHUB_BASE` |
| 记忆 · 检索代理地址 | MCP 网关地址 | 回退 `MEMHUB_PROXY_BASE` |
| 记忆 · 实例名 | 一般 `default` | 回退 `MEMHUB_INSTANCE` |
| 记忆 · API Key | MemHub 的 key | 回退 `memhub-admin-key` |

**地址写法（已放宽）**：`https://` · `http://` · **裸主机**（`192.168.1.10:8080` 会自动补 `https://`，
内网建议显式写 `http://`）· 自定义端口 · 路径前缀（`http://ip:port/wbm`）。
⛔ `http` 会显示"明文"警告但**不阻止** —— 内网自建时它往往唯一可用。

**操作顺序**：

1. 填「知识库 · 服务地址」→ 点 **测试知识库**
   - 期望：`✓ 知识库列表  HTTP 200 · N 条`
   - `401/403` ⇒ key 没填或不对（先填 key 再测）
2. 填 key → 再测一次确认 `200`
3. 填「记忆 · 服务地址」→ 点 **测试记忆**
   - `✓` 或 `HTTP 405` 都算通（405 = 路由在、只是不接受 GET）
4. 全绿后点 **保存（热生效）** —— **不需要重启账号服务**
5. 刷新页面，卡头那行会显示「知识库生效 … · 记忆生效 … / 代理 …」，
   这就是**当前真正在用**的地址（面板值优先，否则环境变量）

## 3. 排错对照表

| 现象 | 原因 | 处置 |
|---|---|---|
| 超时（8 秒） | 地址/端口不对、防火墙、不在同一网段 | 先在账号服务机器上 `curl` 那个地址 |
| 连接被拒绝 | 端口没开 / 容器没起 | `docker ps`、`ss -lntp \| grep <端口>` |
| DNS 解析失败 | 用了域名但 NAS 没有 DNS | 换内网 IP |
| TLS/证书错误 | 自签证书 | 内网改 `http://`，或换正式证书 |
| 401 / 403 | key 不对 / 没带 | 知识库用 `X-API-Key`；记忆用 `Bearer` |
| 404 | 少了路径前缀 / 上游版本不同 | 试 `http://ip:port` 与 `http://ip:port/api` 两种 |
| 200 但"没解析出列表" | 端点存在、返回结构不同 | 连通性没问题；能否真正建库要看上游是否兼容上表端点 |

## 4. 验收清单（最终以用户侧为准）

1. 面板「用户 · 权益 · 积分」里给某账号**开通知识库**
2. 用该账号登录云助手 → 「知识库」标签：应显示**已开通**而不是"未开通/未授权"
3. 上传一个 `.txt` → 列表里应出现该文档
4. 就文档内容提问 → 回答能引用到它（说明 MCP 检索端点通了）
5. 「记忆空间」：对话几轮后新开会话，应能带上之前的要点

## 5. 等价的环境变量（不想用面板时）

| 面板字段 | 环境变量 | 凭据文件（`CREDENTIALS_DIRECTORY`） |
|---|---|---|
| 知识库地址 | `WEKNORA_BASE` | — |
| 知识库 key | `WEKNORA_ADMIN_KEY` | `weknora-admin-key` |
| LLM 模型 | `WEKNORA_LLM_MODEL_ID` | — |
| 嵌入模型 | `WEKNORA_EMBED_MODEL_ID` | — |
| 视觉模型 | `WEKNORA_VLM_MODEL_ID` | — |
| 记忆地址 | `MEMHUB_BASE` | — |
| 记忆代理 | `MEMHUB_PROXY_BASE` | — |
| 记忆实例 | `MEMHUB_INSTANCE` | — |
| 记忆 key | `MEMHUB_ADMIN_KEY` | `memhub-admin-key` |

**优先级：面板配置 > 环境变量/凭据**。面板里留空 = 用环境变量（⛔ 不是清空）。

## 6. 与「模型池 / 闲时倍率」的关系（容易误解）

知识库/记忆用的模型（LLM / 嵌入 / 视觉）是**上游服务自己**去调的，**不走**本服务的
「限时福利」网关，因此：

- **不受** `offPeak`（闲时倍率）影响
- **不从**本服务的积分账本扣分

若希望它们也走自己的网关，需要在上游（WeKnora/MemHub）里把模型 base URL 指向
`https://<你的域名>/cloud-api/proxy/v1` 并使用网关密钥。这条**不是默认行为**，配错会两头都不通。

## 7. 如果飞牛OS 上没有现成应用

按上面的**接口契约**自己跑容器即可 —— 关键是两个服务要满足：

1. 能被账号服务直连（同一内网或打通网络）
2. 鉴权头对得上（知识库 `X-API-Key`、记忆 `Bearer`）
3. 端点路径与上表一致（版本不同就改上游，或改 `server.js` 里的调用路径）

⛔ 不建议为了"能连上"去改账号服务的鉴权头：那是与上游约定的契约，
改了以后升级/换实现会全线失效。
