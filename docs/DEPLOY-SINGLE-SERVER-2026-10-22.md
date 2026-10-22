# 单服务器部署：云端模型 + 记忆网关（两套方案）

> 面向「一台服务器就能跑起来」的部署说明。适用于自建 `ppz123.asia` 这类形态：
> 桌面端把 `baseUrl` 指向本域名的 `/claude-code/<instance>`，由网关完成「记忆注入 + 转发上游 LLM」。
>
> 本文只写**已经踩过的坑**与**可验证的步骤**，不含任何密钥；所有 `<...>` 都要换成你自己的值。

---

## 0. 为什么会有两套方案

当前线上形态（**方案 C**）是「服务器 Caddy → frp 隧道 → 家里 NAS 的 NPM → 记忆代理」。
2026-10-22 的一次事故暴露了它的脆弱性：

```
13:00:02  NAS 上的 frpc 正常退出（client exit success）⇒ 18080 不再监听
13:00 起  所有子域 502（mem / kb / api / memapi），而主站 ppz123.asia 仍 200
16:43:53  机器重新开机，frpc 重新登录、注册 nas-npm-web，18080 恢复，全部服务自动回来
```

结论：**功能没问题，单点在家里那台机器上**。所以给出两套「全部放服务器」的方案：

| | 方案 A 全栈单机 | 方案 B 仅模型通道 | 方案 C 现状（frp 隧道） |
|---|---|---|---|
| 记忆注入（L2/L3 自动进上下文） | ✅ | ❌ | ✅ |
| 模型可用 | ✅ | ✅ | ✅ |
| 依赖家里的 NAS | 否 | 否 | **是（单点）** |
| 密钥体系 | 记忆代理签发 `sk-mem-*` | 需要中继自己的 key | 记忆代理签发 |
| 部署量 | 2 个容器 + Caddy | 只有 Caddy 改写 | 0（但会挂） |

---

## 1. 前置（两套方案通用）

- 一台有公网 IP 的 Linux 服务器，域名 A 记录指向它（如 `memapi.example.com`）。
- Caddy（或 Nginx）已能签 TLS；本文用 Caddy。
- Docker + compose 插件。
- 一个**上游 LLM**：`base_url` + `api_key` + `model`（OpenAI 兼容即可）。

目录约定（下文都用它）：

```
/etc/caddy/Caddyfile              # 主站
/etc/caddy/<domain>-sites.caddy   # 子域转发（被 Caddyfile import）
/opt/memory-proxy/docker-compose.yml
/var/log/caddy/                   # 访问日志
```

---

## 2. 方案 A：全栈单机（记忆 + 模型都在服务器）

### 2.1 拓扑

```
桌面端 ──https──> Caddy ──/claude-code/*──> 记忆代理 127.0.0.1:8096 ──> 上游 LLM
                     └──/health──> 同一实例
```

记忆代理负责：校验 `sk-mem-*` → 按用户注入 L2/L3 记忆与技能 → 转发上游 → 回传（SSE 透传）。

### 2.2 docker-compose

```yaml
# /opt/memory-proxy/docker-compose.yml
services:
  memory-proxy:
    image: <记忆代理镜像>            # 例如团队自建仓库中的 proxy 镜像
    restart: always                  # ⛔ 必须：本次事故就是因为客户端没自启
    ports:
      - "127.0.0.1:8096:8096"        # ⛔ 只绑回环，公网只经 Caddy
    environment:
      LLM_BASE_URL: "<上游 LLM base_url>"      # 例：https://api.example.com/v1
      LLM_API_KEY: "<上游 key>"
      LLM_MODEL: "<默认模型 id>"
      INSTANCE_ID: "default"                    # 对应 URL 里的 /claude-code/<instance>
      ADMIN_KEY_FILE: "/data/.admin-key"        # 首次启动写入，用于面板建 Team/业务用户
    volumes:
      - ./data:/data
```

```bash
cd /opt/memory-proxy && docker compose up -d
docker compose logs --tail=50        # 等到出现 listening / admin key
curl -s http://127.0.0.1:8096/health # 期望：{"status":"ok", ...}
```

### 2.3 Caddy

```caddyfile
# /etc/caddy/memapi-sites.caddy（由 Caddyfile 里 import）
memapi.example.com {
	# ⛔ handle_path 会**剥掉**前缀：/claude-code/default/v1/messages → /v1/messages
	handle_path /claude-code/* {
		reverse_proxy 127.0.0.1:8096
	}
	reverse_proxy 127.0.0.1:8096
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 2.4 客户端（桌面端「模型」页）

| 字段 | 值 |
|---|---|
| Base URL | `https://memapi.example.com/claude-code/default` |
| API Key | `sk-mem-<该用户在面板里签发的 user_key>` |
| 模型 | 面板里为该 Team/Agent 启用的模型 id |
| 上游协议 | `自动`（网关侧负责翻译；若只支持 Responses 也可显式选 `responses`） |

### 2.5 验证清单

```bash
curl -s https://memapi.example.com/health
curl -s https://memapi.example.com/claude-code/default/v1/models            # 无 key 应 401/鉴权错误，⛔ 不该是 502
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://memapi.example.com/claude-code/default/v1/messages \
  -H 'content-type: application/json' -H 'authorization: Bearer sk-mem-xxx' \
  -d '{"model":"<模型>","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
```

判据：**/health 200 + 鉴权错误（而不是 502）** ⇒ 网关活着；带上真 key 能出 token ⇒ 全链路通。

---

## 3. 方案 B：只搬模型通道（不带记忆）

适用：不想部署记忆代理，只需要「云端模型能用」。

### 3.1 关键前提（⛔ 先读）

桌面端发出去的是 `Authorization: Bearer sk-mem-*`（记忆代理签发的用户 key），
而**上游中继认的是它自己的 key**（自行管理的密钥库）。两者的换 key 动作原本发生在记忆代理里。

⇒ 方案 B 必须解决「谁把 `sk-mem-*` 换成中继 key」，两条路：

1. **中继侧认 `sk-mem-*`**：在转发层加一条 `sk-mem-* → 中继 key` 的映射（推荐，一次性）；
2. **客户端直填中继 key**：把用户中心的模型档案改成「中继 baseUrl + 中继 key」，
   即不再经过 `/claude-code/<instance>` 这层。

⚠️ 直接改写 Caddy 而不做上面任一条 ⇒ 客户端会拿到 `401 invalid api key`（不是 502），
这是**预期**的，别误判成网关挂了。

### 3.2 Caddy（前缀剥离 + 直连中继）

```caddyfile
memapi.example.com {
	# 只保留模型通道：/claude-code/default/v1/* → 中继 /v1/*
	handle_path /claude-code/* {
		reverse_proxy 127.0.0.1:18081
	}
	respond /health 200
	reverse_proxy 127.0.0.1:18081
}
```

`18081` = 供应商中继（本仓之外的独立服务，只认自己的 key）。它认识模型 id 映射
（如 `space-bunny` → 上游真名），并对 `/v1/chat/completions`、`/v1/messages` 双向服务。

### 3.3 能力差异（必须让用户知道）

| 能力 | 方案 A | 方案 B |
|---|---|---|
| 云端记忆自动注入 | ✅ | ❌（每轮不再带 L2/L3） |
| 云端知识库自动检索 | ✅ | ❌ |
| 模型出话 | ✅ | ✅ |
| 计费口径 | 代理侧 | 中继侧 |

---

## 4. 方案 C（现状）：frp 隧道，仅作对照

```
Caddy ──> 127.0.0.1:18080 ──frps──> frpc(家里 NAS) ──> NAS 上的 NPM ──> 各服务
```

`/etc/frp/frps.toml`（服务器）：

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
auth.token = "<48 位随机串>"                       # ⛔ 客户端必须一致，否则 login 被拒
allowPorts = [{ start = 18000, end = 18099 }]
webServer.addr = "127.0.0.1"
webServer.port = 7500
```

NAS 侧 `frpc.toml`：

```toml
serverAddr = "<服务器公网 IP>"
serverPort = 7000
auth.token = "<与服务器完全一致>"
[[proxies]]
name = "nas-npm-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 18080          # NAS 上 NPM 的端口
remotePort = 18080         # 服务器上 Caddy 转发的目标
```

**已知风险**：NAS 重启/系统更新后，若容器没设 `restart: always`，隧道不会自己回来，
表现就是**所有子域 502、主站正常**。要长期稳定，请迁移到方案 A。

---

## 5. 运维加固（本次事故的补丁）

1. **容器一律 `restart: always`**，并确认开机自启（fnOS / Docker 面板里都有开关）。
2. **断线看门狗**（服务器，每分钟记录一次，便于回溯断线起点）：

```bash
cat >/usr/local/bin/ppz-nas-watch.sh <<'EOF'
#!/bin/bash
# 18080 = NAS 隧道端口；没有监听 = 所有子域 502
if ! ss -lntH | grep -q ":18080 "; then logger -t ppz-tunnel "18080 无监听（NAS 隧道断开）"; fi
EOF
chmod +x /usr/local/bin/ppz-nas-watch.sh
(sudo crontab -l; echo "* * * * * /usr/local/bin/ppz-nas-watch.sh") | sudo crontab -
# 查询：journalctl -t ppz-tunnel --since today
```

3. **改反代前先备份**：`cp /etc/caddy/<file>.caddy /etc/caddy/<file>.caddy.bak-$(date +%Y%m%d)`
4. **⛔ 改反代指向之前先确认端口身份**：

```bash
sudo ss -lptnp | grep -E ':8096|:18080|:18081'
sudo ps -o pid,cmd -p <pid>
```

> 只看 `/health` 返回 200 会被 SPA 的 catch-all 骗（它会把未知路径也回首页 HTML）。
> 2026-10-22 就曾把 8097（WorkBuddy 重试代理）误当成记忆网关，结果公网返回 200 HTML。

---

## 6. 排障手册（按顺序，6 条命令定位到底）

```bash
# 1) 客户端还是服务端？—— 先打根路径
curl -I https://memapi.example.com/            # 200 ⇒ 边缘正常；502 ⇒ 上游没起来

# 2) 反代目标是谁？
sudo grep -n reverse_proxy /etc/caddy/*.caddy

# 3) 那个端口有人在听吗？
sudo ss -lntp | grep <port>                    # 没有 ⇒ 后端没起（或隧道断了）

# 4) 是容器还是进程？
sudo docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
sudo ps -o pid,cmd -p <pid>                    # ⛔ 一定要看命令行，别信端口号看着像

# 5) 隧道（方案 C）
sudo systemctl status frps --no-pager
sudo journalctl -u frps --since '-3h' | grep -E 'client login|new proxy|client exit|token'

# 6) 应用侧日志
journalctl -t ppz-tunnel --since today         # 看门狗记录的断线起点
```

**判据记忆法**：根路径 502 ⇒ 服务端；只有特定路径 4xx ⇒ 客户端协议/参数/密钥。
`token in login doesn't match` 这类登录失败**多半是公网扫描器**（无 hostname、云 IP、版本对不上），
不要当成用户侧证据 —— 认 **同一个 client id + hostname** 才算。
