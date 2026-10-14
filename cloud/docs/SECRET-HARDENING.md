# 密钥与地址安全加固方案（云助手 × WorkBuddy Manager）

> 2026-10-14 立。起因：用户要求「不要让地址与密钥出现在源码/日志/前端，改环境或密钥管理读取，
> 加密存储与传输，并在请求侧加来源校验/鉴权/签名，防反向代理与盗用」。本文说明**已实施的方案**
> 与**为什么不采用某些看似更强的做法**（不做安全剧场）。

---

## 0. 一句话结论

| 要求 | 落地手段 |
|---|---|
| ① 源码/日志/前端不出现地址与密钥 | 仓库审计 0 命中；`/models` 不再下发上游地址与网关密钥（只给同源代理路径）；日志统一脱敏 |
| ② 环境变量或密钥管理读取 | `readSecret()`：**systemd 凭据目录 → 环境变量 → 空**（空就如实报"未配置"，不猜地址） |
| ③ 加密存储与传输 | 存储：`systemd-creds` 加密凭据（AES-256-GCM，宿主机密钥，0600 root，明文 shred）；传输：HTTPS + 服务间走回环 |
| ④ 请求侧校验 | 每用户代理令牌（库内只存哈希）+ **来源 IP 绑定**（≤5，超出即拒）+ 账号停用即拒 + 上游密钥**服务端注入** |

---

## 1. 威胁模型（先说清防谁）

| 威胁 | 是否在范围内 | 说明 |
|---|---|---|
| 源码被看到 / 仓库泄露 | ✅ 范围内 | 所以仓库里**不能有**任何密钥与上游地址 |
| 前端（浏览器可读）拿到密钥 | ✅ 范围内 | 客户端只允许持有**可吊销、可轮换、非上游**的代理令牌 |
| 日志被翻 / 排障时外泄 | ✅ 范围内 | 统一 `sanitize()` 脱敏，出错信息也过一遍 |
| 令牌被转发给别人用（反向代理盗用） | ✅ 范围内 | 来源 IP 绑定 + 停用即拒 + 令牌哈希存储 + 可轮换 |
| 拿到机器 root / 宿主机磁盘镜像 | ❌ 不承诺 | 无 TPM 时宿主机密钥在 root-only 文件里，root 可解 —— 属基础设施层，不在应用层解决 |
| 上游（腾讯）侧风控 | ❌ 不在本文 | 由 WBM 既有机制负责 |

---

## 2. ① 不暴露：改了什么

| 位置 | 改前 | 改后 |
|---|---|---|
| 上游地址 | 代码默认值里写死回环地址 | 只从 `WBM_BASE` 环境变量读；**空则报未配置** |
| 上游网关密钥 | `/models` 把 `wbk_…` 明文返回给客户端 | **不再下发**；改下发同源代理路径 `/cloud-api/proxy/v1` |
| 上游地址下发前端 | 前端看到 `http://…:7864/v1` | 前端只看到**同源路径**，真实地址不出服务端 |
| 日志 | 可能带 URL / 异常信息 | `sanitize()` 把 `wbt_`/`wbk_` 一律换成 `wbt_abcd…[已脱敏]` |
| 启动横幅 | —— | 只说"已配置/未配置"，**不打印任何值** |

**审计结果**（本轮实测）：仓库内 `wbt_/wbk_` 明文 **0 命中**；硬编码上游地址：仅剩服务端一处
（已改为环境变量读取）；服务器侧日志 0 命中。

---

## 3. ② 读取方式：凭据 → 环境 → 空

```js
function readSecret(name, envName) {
  const dir = process.env.CREDENTIALS_DIRECTORY || "";   // systemd 注入，仅本服务可读
  if (dir) { try { const v = fs.readFileSync(path.join(dir, name), "utf8").trim(); if (v) return v; } catch {} }
  return String(process.env[envName] || "").trim();        // 本地开发用
}
```

- 服务单元：`LoadCredentialEncrypted=wbm-token:/etc/codex-assistant/wbm-token.cred`
- **凭据目录是 systemd 挂给该服务的 tmpfs**，路径随进程变化、其它用户读不到（比"环境变量"更强：
  环境变量在 `/proc/<pid>/environ` 里对本机 root 可见，而凭据文件只在该服务命名空间内）

---

## 4. ③ 加密：存储与传输

### 4.1 存储（已实施）

```bash
# 生成 → 加密 → 立即 shred 明文（全程不打印密钥）
systemd-creds encrypt --name=wbm-token /home/ubuntu/.wbm-token.plain /etc/codex-assistant/wbm-token.cred
chmod 600 /etc/codex-assistant/wbm-token.cred   # root:root
shred -u /home/ubuntu/.wbm-token.plain
```

- 算法与密钥：`systemd-creds` 用 **AES-256-GCM**，密钥来自宿主机（TPM 或
  `/var/lib/systemd/credential.secret`，root-only）⇒ **把 .cred 文件拷到别的机器解不开**。
- ⛔ **诚实说明**：本机没有 TPM，systemd 会打印
  `Credential secret file '.../credential.secret' is not located on encrypted media, using anyway` ——
  即"root + 磁盘"仍可解出。这挡住的是**配置泄露/备份泄露/普通用户**，不是 root 本身。
- 令牌轮换：本轮已把先前在终端出现过的那把 token **作废**，新 token 只在服务器本地生成并直接加密。

### 4.2 传输

| 链路 | 加密 | 说明 |
|---|---|---|
| 客户端（浏览器）→ 服务器 | HTTPS（Caddy 自动证书） | 会话 Cookie 带 `HttpOnly`/`SameSite` |
| 客户端（本机助手）→ 服务器 | HTTPS | 代理令牌走 `Authorization: Bearer` |
| 服务器 → WBM（`WBM_BASE`） | **回环，不出网卡** | `127.0.0.1` ⇒ 明文在回环是合理选择；这也是"地址不外发"的前提 |
| WBM 自身的公网入口 | 它自己的 HTTPS + 登录 | 与本方案解耦 |

---

## 5. ④ 请求侧校验：代理转发链

```
本机助手/引擎 ──Bearer wap_<每用户令牌>──► 云助手 /cloud-api/proxy/v1/chat/completions
                                              │  ①前缀与哈希校验（库内只存 sha256）
                                              │  ②账号未停用
                                              │  ③来源 IP 绑定（首次记住，≤5 个，超出即 403）
                                              │  ④注入 Authorization: Bearer <wbk_…>（服务端持有）
                                              ▼
                                          WBM /v1/chat/completions（回环）
```

| 控制 | 实现 | 为什么这样做 |
|---|---|---|
| 前缀区分 | `wap_`（代理令牌）/ `wbt_`（WBM 管理面）/ `wbk_`（WBM 网关） | 三类凭据用途不同，一眼可辨、便于日志过滤 |
| 只存哈希 | `db.proxyTokens[user] = { hash: sha256(token), prefix, ips[] }` | 拖库拿不到可用令牌（与 WBM 的 `api_tokens` 同形态） |
| 明文只发一次 | `POST /proxy/token` 签发/轮换，响应里给明文一次 | 之后无法再取；客户端丢失就重签（等同吊销旧的） |
| **IP 绑定** | 首次使用记住来源 IP，最多 5 个；新 IP 超出即 403 | 直接对抗"把我的令牌挂到别人反向代理上再用" |
| 停用即拒 | 账号 `disabled` ⇒ 403 | 与既有账号状态联动 |
| 上游密钥注入 | 只在服务端替换 `Authorization` | 客户端**永远拿不到**能绕过云助手直接打上游的凭据 |
| 未配置不降级 | 缺网关密钥 ⇒ **503 + 明确原因** | 不静默回退到"直连上游"（那等于把地址暴露出去） |

### 5.1 为什么**没有**对模型调用加 HMAC 签名

- 模型调用方是**第三方引擎**（`@openai/codex`），它只会发 `Authorization: Bearer`，
  **不会**按我们的规则签名 ⇒ 强制签名只能是"客户端改引擎"或"签了也不验"，两者都不成立。
- 在该链路上，"签名"想解决的其实是**盗用与转发**，而 **IP 绑定 + 令牌哈希 + 一次性明文 + 可轮换**
  是这类客户端能真正执行的等价（且更强：能撤销）的控制。
- 反之，凡是**我们自己的服务间调用**（`chc-account` → WBM），走的是**回环**，
  没有任何网络跳转可被劫持 ⇒ 加签名只是安全剧场，不做。

### 5.2 我们的网页 UI（浏览器侧）另有一层

管理类写操作（发积分、删数据、改绑定）一律要求**登录会话 + 管理员角色**，并且：
- 写操作只接受**本机页面来源**（`Origin` 白名单）或合法本机令牌（`localUiAuthOk`）；
- 读接口（同源 GET 不带 `Origin`，规范如此）用宽松判定，**写接口**才用严格判定 ——
  这一分工是刻意的，避免"为了安全把所有 GET 都锁死"导致功能坏掉。

---

## 6. 运维与轮换

| 动作 | 命令 / 入口 |
|---|---|
| 轮换 WBM 只读令牌 | 服务器本地跑生成脚本 → `systemd-creds encrypt` → 重启服务（见 §4.1，全程不落盘明文） |
| 吊销某用户代理令牌 | 删 `db.proxyTokens[username]` 并 `persist()`；用户端在云端管理点"重新签发" |
| 检查是否泄露 | `grep -rE "(wbt\|wbk)_[A-Za-z0-9_-]{6,}"`（仓库）/ `journalctl -u chc-account \| grep -c wbt_`（日志） |
| 撤销设备（防盗用） | 用户中心「解除配对」（≤3 台限额同处管理） |

---

## 7. 未做与后续（明确列出，避免"声称有、其实没有"）

- **网关密钥（`wbk_`）尚未配置** ⇒ 代理会如实返回 503 `upstream-not-configured`；
  配置方式与令牌相同（`systemd-creds encrypt --name=wbm-gateway-key`）。
- 代理目前透传 `/v1/models` 与 `/v1/chat/completions`（含流式）；**计费核对**依赖 WBM 侧
  `usage_*.credit`，属下一步（见 `WBM-POINTS-INTEGRATION.md`）。
- 未做"请求体签名"与"时间戳防重放"：当前链路要么是回环、要么是第三方引擎（无法签名），
  已用 IP 绑定替代；**若将来出现"我们自己的服务跨公网互调"，再引入 HMAC + 时间窗 + nonce**。
