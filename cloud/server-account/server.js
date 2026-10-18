"use strict";
/* ══════════════════════════════════════════════════════════════════════════
   Codex Harness Cloud · 账号服务（跑在站长的服务器上，不随桌面助手分发）

   职责：账号密码注册/登录、会话、管理员用户管理。**只存身份，不存任何用户内容**
   （会话/文件/凭据仍全在各用户本机）—— 服务器被拖库最多泄露账号表。

   安全设计（用户明确不要验证码 ⇒ 用限速 + 锁定 + 常量时间比较替代）：
   · 密码 scrypt + 每用户独立盐；校验全程 timingSafeEqual
   · 注册：每 IP 每小时 3 次；用户名 3~24 位 [A-Za-z0-9_-]；密码 ≥8 位
   · 登录：每 IP 10 次/5 分钟；单账号连错 5 次锁 15 分钟
   · 会话：随机 32B token，服务端只存 sha256，7 天过期，登出即吊销
   · 管理员：--init-admin 签发（首建即 admin），可禁用/启用/重置/删除用户
   · 绑定 127.0.0.1，只经 Caddy 反代对外；CORS 只放行站点自身 Origin
   ══════════════════════════════════════════════════════════════════════════ */
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.HARNESS_ACCOUNTS_PORT || 8091);
/* 本服务版本（10-18「云端管理加更新功能」）：读包根 VERSION，读不到就 dev。
   ⛔ 不写死在代码里 —— 否则每次发版要改两处，迟早不一致。 */
const APP_VERSION = (() => {
  try { return String(fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8")).trim() || "dev"; } catch { return "dev"; }
})();
/** 可自部署的那个仓（面板「获取可部署版本」与更新检查都指向它）。 */
const DEPLOY_REPO = "https://github.com/PMZPZM0/codex-cloud-assistant";
/** 更新检查的源（10-18 用户令「**默认走国内镜像**更新」）：
 *  **国内镜像优先**，直连放最后兜底。按顺序试、第一个成功的就用。
 *  ⛔ 用镜像的 raw 透传（`<mirror>https://raw.githubusercontent.com/...`）——
 *     raw 不计 GitHub API 配额；⛔ 它只读一个 VERSION 文本，不涉及代码与执行。 */
const UPDATE_MIRRORS = [
  { name: "ghfast（国内）", prefix: "https://ghfast.top/" },
  { name: "gh-proxy（国内）", prefix: "https://gh-proxy.com/" },
  { name: "ghproxy.net（国内）", prefix: "https://ghproxy.net/" },
  { name: "gitmirror（国内）", prefix: "https://hub.gitmirror.com/" },
  { name: "moeyy（国内）", prefix: "https://github.moeyy.xyz/" },
  { name: "直连（兜底）", prefix: "" },
];
/** 版本比较（只比 x.y.z 的数字段）：a>b 返回正数。
 *  ⛔ 不要用字符串比较 —— `"1.0.10" < "1.0.9"` 会判错，用户就会一直以为"没有新版本"。 */
function cmpVersion(a, b) {
  const pa = String(a || "").replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  const pb = String(b || "").replace(/^v/, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
const DATA_FILE = process.env.HARNESS_ACCOUNTS_FILE || path.join(__dirname, "data.json");
/* ── 配额（单一真相源；界面文案从 /sync/usage 与 /device/list 读，别在前端再写一份） ── */
const DEVICE_LIMIT = Number(process.env.HARNESS_DEVICE_LIMIT || 3);                       // 每账号最多绑定机器数
const STORAGE_LIMIT_BYTES = Number(process.env.HARNESS_STORAGE_LIMIT || 1024 * 1024 * 1024); // 每账号 1 GB
/* 10-15 管理员可按用户覆盖云存储配额（data.json.storageQuota[username] = 字节数）；
   未设置的用户回落全局默认。所有配额判断/回显统一走这里，别再直读 STORAGE_LIMIT_BYTES。 */
function storageLimitFor(username) {
  try {
    const v = db.storageQuota && db.storageQuota[username];
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* ignore */ }
  return STORAGE_LIMIT_BYTES;
}
/** 云端数据落盘根：与账号文件同目录，便于一起备份/迁移。 */
const SYNC_DIR = process.env.HARNESS_SYNC_DIR || path.join(path.dirname(DATA_FILE), "sync");
/* ── 内置供应商「限时福利」：模型目录来自 WBM（WorkBuddy Manager） ──────────────
   ⛔⛔ 安全加固（10-14 用户令）：地址与密钥**一律不硬编码、不入日志、不下发前端**。
   · 取值顺序：systemd 凭据目录（$CREDENTIALS_DIRECTORY/<name>，宿主机密钥加密）
     → 环境变量（本地开发用）→ 空（如实报"未配置"，**不猜地址**）
   · 启动/日志里只出现"是否已配置"，任何出错信息都要过 sanitize() 脱敏。 */
function readSecret(name, envName) {
  const dir = process.env.CREDENTIALS_DIRECTORY || "";
  if (dir) {
    try {
      const v = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (v) return v;
    } catch { /* 凭据不存在就走环境变量 */ }
  }
  return String(process.env[envName] || "").trim();
}
/* ── 10-16 每用户集成凭据签发（用户定案：**凭据走云端下发**、**知识库每人各自一个**）──────
   为什么放这个服务：它已经是「账号 → 本机」的唯一凭据签发处（`/proxy/token` 同款纪律）。
   · 客户端只拿**自己的**那支只读令牌；上游管理员凭据只存在本服务（systemd 加密凭据）。
   · ⛔ WeKnora 的 MCP 令牌**只在创建/轮换时明文返回一次** ⇒ 本服务必须留存才能重发，
     落在 data.json（0600，与 proxyTokens 同级）；轮换走 WeKnora 侧的 rotate-token。
   · 幂等：同一账号重复领取只补缺，不重复建库/建端点。 */
/* ⛔ 10-18：这些从 `const` 改为 `let` —— 允许管理员在面板里配（覆盖环境变量，**热生效**）。
   覆盖来源 = `db.services.{kb,memory}`，由 `applyServiceOverrides()` 在 db 加载后与每次保存后套用。
   ⛔ 留空的字段一律**回落环境变量/凭据**（不是清空）—— 否则改一个字段会把其它配置抹掉。 */
let WEKNORA_BASE = String(process.env.WEKNORA_BASE || "https://kb.ppz123.asia").replace(/\/+$/, "");
const WEKNORA_ENV_BASE = WEKNORA_BASE;                     // 环境变量原值（回退与"是否被覆盖"判定用）
let WEKNORA_ADMIN_KEY = readSecret("weknora-admin-key", "WEKNORA_ADMIN_KEY");
const WEKNORA_ENV_ADMIN_KEY = WEKNORA_ADMIN_KEY;
let WEKNORA_LLM_MODEL_ID = String(process.env.WEKNORA_LLM_MODEL_ID || "").trim();
let WEKNORA_EMBED_MODEL_ID = String(process.env.WEKNORA_EMBED_MODEL_ID || "").trim();
/* 视觉模型（VLM）：图片上传/理解必需。⛔ 没配它的时候**必须**拦掉图片上传并说人话，
   否则上游只会回一句 "上传图片文件需要设置VLM模型"（10-16 用户实测踩到）。 */
let WEKNORA_VLM_MODEL_ID = String(process.env.WEKNORA_VLM_MODEL_ID || "").trim();
const WEKNORA_ENV_MODEL_IDS = { llm: WEKNORA_LLM_MODEL_ID, embed: WEKNORA_EMBED_MODEL_ID, vlm: WEKNORA_VLM_MODEL_ID };

/** 知识库的模型配置体（首次建库与后续补挂视觉模型共用一份，避免两处漂移）。 */
function kbModelConfigBody() {
  const body = {
    llmModelId: WEKNORA_LLM_MODEL_ID,
    documentSplitting: { chunkSize: 512, chunkOverlap: 80, separators: ["\n\n", "\n", "。"], enableParentChild: false },
    multimodal: { enabled: Boolean(WEKNORA_VLM_MODEL_ID) },
    storageProvider: "local",
    nodeExtract: { enabled: false },
    questionGeneration: { enabled: false },
  };
  if (WEKNORA_EMBED_MODEL_ID) body.embeddingModelId = WEKNORA_EMBED_MODEL_ID;
  if (WEKNORA_VLM_MODEL_ID) body.vlm_config = { enabled: true, model_id: WEKNORA_VLM_MODEL_ID };
  return body;
}
let MEMHUB_BASE = String(process.env.MEMHUB_BASE || "https://mem.ppz123.asia").replace(/\/+$/, "");
const MEMHUB_ENV_BASE = MEMHUB_BASE;
let MEMHUB_ADMIN_KEY = readSecret("memhub-admin-key", "MEMHUB_ADMIN_KEY");
const MEMHUB_ENV_ADMIN_KEY = MEMHUB_ADMIN_KEY;
let MEMHUB_INSTANCE = String(process.env.MEMHUB_INSTANCE || "default").trim();
let MEMHUB_PROXY_BASE = String(process.env.MEMHUB_PROXY_BASE || "https://memapi.ppz123.asia").replace(/\/+$/, "");
const MEMHUB_ENV_PROXY_BASE = MEMHUB_PROXY_BASE;
const MEMHUB_ENV_INSTANCE = MEMHUB_INSTANCE;

function integrationSecretsOk() {
  return { knowledge: Boolean(WEKNORA_ADMIN_KEY), memory: Boolean(MEMHUB_ADMIN_KEY) };
}

/** 以服务端管理员身份调 WeKnora（客户端永远看不到这把 key）。
 *  ⛔ 鉴权头是 **`X-API-Key`**（租户 API Key），不是 `Authorization: Bearer` ——
 *    后者是 JWT 的口子，拿 API Key 去走会 401 `invalid or expired token`（10-16 实测踩过）。 */
async function weknoraAdmin(pathname, options = {}) {
  const res = await fetch(`${WEKNORA_BASE}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", "X-API-Key": WEKNORA_ADMIN_KEY },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) throw new Error(`weknora ${options.method || "GET"} ${pathname} → ${res.status} ${sanitize(text.slice(0, 160))}`);
  return json;
}

function integrationSlot(username) {
  if (typeof db.integrations !== "object" || !db.integrations) db.integrations = {};
  const cur = db.integrations[username];
  if (typeof cur !== "object" || !cur) db.integrations[username] = {};
  return db.integrations[username];
}

/** 资源是否还在。返回 true=在 / false=**确定** 404（已删）/ null=未知（网络问题，不改动缓存）。
 *  ⛔ 必须区分"确定不存在"和"暂时问不到"：把网络抖动当删除会导致重复建库。 */
async function weknoraAlive(pathname) {
  try {
    const res = await fetch(`${WEKNORA_BASE}${pathname}`, { headers: { "X-API-Key": WEKNORA_ADMIN_KEY } });
    if (res.status === 404) return false;
    return res.ok ? true : null;
  } catch { return null; }
}

/** 幂等备好该账号**自己的**知识库 + 只读 MCP 端点。 */
async function ensureKnowledgeFor(username) {
  if (!WEKNORA_ADMIN_KEY) return { ok: false, error: "knowledge-not-configured" };
  const cur = integrationSlot(username);
  const kbName = `u-${String(username).replace(/[^\w.-]+/g, "_").slice(0, 40)}`;
  /* 缓存自愈：管理员在 WeKnora 里删了库/端点 ⇒ 缓存就成了死引用，必须重建（10-16 实测踩到）。 */
  if (cur.kbId && (await weknoraAlive(`/api/v1/knowledge-bases/${cur.kbId}`)) === false) {
    cur.kbId = ""; cur.endpointId = ""; cur.mcpToken = ""; cur.mcpUrl = "";
  }
  if (cur.endpointId && (await weknoraAlive(`/api/v1/mcp-endpoints/${cur.endpointId}`)) === false) {
    cur.endpointId = ""; cur.mcpToken = ""; cur.mcpUrl = "";
  }
  if (!cur.kbId) {
    const created = await weknoraAdmin("/api/v1/knowledge-bases", { method: "POST", body: { name: kbName, description: `账号 ${username} 的私有知识库（云端自动创建）`, type: "document" } });
    cur.kbId = String((created && created.data && created.data.id) || "");
    if (!cur.kbId) throw new Error("建库未返回 id");
    if (WEKNORA_LLM_MODEL_ID) {
      await weknoraAdmin(`/api/v1/initialization/config/${cur.kbId}`, { method: "PUT", body: kbModelConfigBody() });
      cur.vlmModelId = WEKNORA_VLM_MODEL_ID || "";
    }
    cur.kbName = kbName;
    persist();
  } else if (WEKNORA_VLM_MODEL_ID && cur.vlmModelId !== WEKNORA_VLM_MODEL_ID) {
    /* 老库补挂视觉模型（10-16：支持图片上传）——配置变更对已有文件无影响，幂等。 */
    await weknoraAdmin(`/api/v1/initialization/config/${cur.kbId}`, { method: "PUT", body: kbModelConfigBody() });
    cur.vlmModelId = WEKNORA_VLM_MODEL_ID;
    persist();
  }
  if (!cur.endpointId || !cur.mcpToken) {
    const ep = await weknoraAdmin("/api/v1/mcp-endpoints", { method: "POST", body: { name: `codex-${kbName}`, description: "云端为用户下发的只读检索端点", enabled: true, knowledge_base_ids: [cur.kbId], tools: ["list_knowledge_bases", "search_knowledge", "grep_chunks", "list_documents", "read_document", "ask"], rate_limit_per_minute: 120 } });
    const data = (ep && ep.data) || {};
    cur.endpointId = String(data.id || "");
    cur.mcpToken = String(data.token || "");
    cur.mcpUrl = cur.endpointId ? `${WEKNORA_BASE}/mcp/${cur.endpointId}` : "";
    persist();
  }
  return { ok: true, kbId: cur.kbId, kbName: cur.kbName || kbName, mcpUrl: cur.mcpUrl, mcpToken: cur.mcpToken };
}

/** 幂等备好该账号的记忆中枢 user_key（每人一支）。 */
async function ensureMemoryFor(username) {
  if (!MEMHUB_ADMIN_KEY) return { ok: false, error: "memory-not-configured" };
  const cur = integrationSlot(username);
  if (!cur.memKey) {
    const res = await fetch(`${MEMHUB_BASE}/api/v1/meta/user/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tdai-Service-Id": MEMHUB_INSTANCE, "X-Tdai-User-Key": MEMHUB_ADMIN_KEY },
      body: JSON.stringify({ username: `chc-${String(username).slice(0, 40)}` }),
    });
    const json = await res.json().catch(() => null);
    const key = json && json.data && json.data.default_user_key;
    if (!key) throw new Error(`建记忆用户未返回 key（${res.status}）`);
    cur.memKey = String(key);
    cur.memUserId = String((json.data && json.data.user_id) || "");
    persist();
  }
  return { ok: true, baseUrl: `${MEMHUB_PROXY_BASE}/v1`, userKey: cur.memKey, instanceId: MEMHUB_INSTANCE, apiKeyHeader: "X-Tdai-User-Key" };
}

/* ── 10-16 权益：知识库 / 记忆「按时长 + 额度」激活（用户定案）──────────────────────
   · 默认**全关**：新账号只有普通聊天；要激活才下发凭据。
   · 闸门放在 /integrations：未开通 ⇒ **不建库、不发钥匙**（省资源 + 防白嫖），直接 not-activated。
   · 时长 = expiresAt（0 表示永久）；额度 = quotaMb（存储）+ quota（检索次数），used* 由调用侧累计。
   · 开通两条路：管理员手动（/admin/entitlements）+ 用户自助扣积分（/entitlements/activate）。
     价格表 db.pricing 可在后台改，改完即生效。 */
const FEATURES = ["knowledge", "memory"];
const FEATURE_LABEL = { knowledge: "知识库", memory: "记忆" };
const DEFAULT_PRICING = {
  /* 容量默认各 1 GB、两项**互相独立**（用户 10-16 定案）；记忆另有检索次数上限。 */
  knowledge: { points: 500, days: 30, quotaMb: 1024, quota: 0 },
  memory: { points: 300, days: 30, quotaMb: 1024, quota: 2000 },
};

function pricingOf() {
  const base = db.pricing && typeof db.pricing === "object" ? db.pricing : {};
  const out = {};
  for (const f of FEATURES) out[f] = { ...DEFAULT_PRICING[f], ...(base[f] && typeof base[f] === "object" ? base[f] : {}) };
  return out;
}

function entitlementsOf(username) {
  if (typeof db.entitlements !== "object" || !db.entitlements) db.entitlements = {};
  const cur = db.entitlements[username];
  if (typeof cur !== "object" || !cur) db.entitlements[username] = {};
  return db.entitlements[username];
}

/** 归一化的权益状态（含过期判定）—— 所有判定只走这一个函数，别在别处重写。 */
function featureState(username, feature) {
  const raw = entitlementsOf(username)[feature];
  const zero = { enabled: false, expired: false, expiresAt: 0, quotaMb: 0, usedMb: 0, quota: 0, usedCount: 0, grantedAt: 0, note: "" };
  if (!raw || !raw.enabled) return zero;
  const expiresAt = Number(raw.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) return { ...zero, expiresAt, expired: true, grantedAt: Number(raw.grantedAt || 0), note: String(raw.note || "") };
  return {
    enabled: true,
    expired: false,
    expiresAt,
    quotaMb: Number(raw.quotaMb || 0),
    usedMb: Number(raw.usedMb || 0),
    quota: Number(raw.quota || 0),
    usedCount: Number(raw.usedCount || 0),
    grantedAt: Number(raw.grantedAt || 0),
    note: String(raw.note || ""),
  };
}

function entitlementsSummary(username) {
  const out = {};
  for (const f of FEATURES) out[f] = featureState(username, f);
  return out;
}

/** 开通 / 续期 / 停用。days>0 在**现有到期时间**上叠加（续期），days=0 表示永久。 */
function grantFeature(username, feature, options = {}) {
  const slot = entitlementsOf(username);
  const cur = slot[feature] && typeof slot[feature] === "object" ? slot[feature] : {};
  const now = Date.now();
  if (options.disable) {
    slot[feature] = { ...cur, enabled: false, disabledAt: now, note: String(options.note || cur.note || "") };
    persist();
    return featureState(username, feature);
  }
  const daysRaw = options.days;
  const base = Number(cur.expiresAt || 0) > now ? Number(cur.expiresAt) : now;
  /* ⛔ days 不传（null/undefined）= **只改额度**：状态与到期时间都保持原样。
     这有两个必须守住的点：① 改了容量不能把限期误置成永久；② 未开通的项**不能被悄悄激活**
     （否则"预设容量"会变成白送开通）。 */
  if (daysRaw === null || daysRaw === undefined) {
    slot[feature] = {
      ...cur,
      quotaMb: Number(options.quotaMb !== undefined ? options.quotaMb : cur.quotaMb || 0),
      quota: Number(options.quota !== undefined ? options.quota : cur.quota || 0),
      updatedAt: now,
    };
    persist();
    return featureState(username, feature);
  }
  const expiresAt = Number(daysRaw) > 0 ? base + Number(daysRaw) * 86400_000 : 0;
  slot[feature] = {
    enabled: true,
    expiresAt,
    grantedAt: now,
    quotaMb: Number(options.quotaMb !== undefined ? options.quotaMb : cur.quotaMb || 0),
    usedMb: Number(cur.usedMb || 0),
    quota: Number(options.quota !== undefined ? options.quota : cur.quota || 0),
    usedCount: Number(cur.usedCount || 0),
    note: String(options.note || ""),
  };
  persist();
  return featureState(username, feature);
}

/** 开通后**立刻预热**该用户的资源（建库/建端点/建记忆账号）。
 *  ⛔ 不阻塞响应（远端建库要 1~3 秒，让"激活"按钮等它就是坏体验）；失败只记日志，
 *    因为所有消费入口（/integrations、/kb/*）都会再调一次 ensure*，幂等兜底。 */
function provisionFor(username, feature) {
  const job = feature === "knowledge" ? ensureKnowledgeFor(username) : ensureMemoryFor(username);
  Promise.resolve(job)
    .then((r) => { if (r && r.ok === false) console.warn(`[provision] ${username}/${feature} 未就绪：${sanitize(String(r.error || ""))}`); })
    .catch((e) => console.warn(`[provision] ${username}/${feature} 失败：${sanitize(String((e && e.message) || e))}`));
}

/** 日志脱敏：把任何形如 wbt_/wbk_ 的凭据换成前缀+掩码（前缀留 8 位便于排障）。 */
/** 日志脱敏：把任何形如 wbt_/wbk_ 的凭据换成前缀+掩码（前缀留 8 位便于排障）。
 *  ⛔ 10-16 扩展：本轮新增的凭据家族（`wap_` 代理令牌 / `sk-mem-` 记忆钥匙 / `mcp_` 端点令牌）
 *    必须一并脱敏 —— 否则上游错误里带回的令牌会被原样写进日志（原来只遮 wbt_/wbk_）。 */
function sanitize(text) {
  return String(text == null ? "" : text)
    .replace(/(wbt_|wbk_|wap_|mcp_|sk-mem-)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, "$1$2…[已脱敏]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-…[已脱敏]");
}
const WBM_BASE = String(process.env.WBM_BASE || "").trim().replace(/\/+$/, "");
const WBM_TOKEN = readSecret("wbm-token", "WBM_TOKEN");
const WBM_GATEWAY_KEY = readSecret("wbm-gateway-key", "WBM_GATEWAY_KEY");
/* 10-15 管理员接口配置：上游 API 地址/网关密钥可由管理员在客户端「云端管理」面板覆盖
   （存 data.json.upstream，热生效免重启）。优先级：管理员配置 > 环境变量/凭据。 */
function readUpstreamOverride() {
  try { const u = db && db.upstream; if (u && typeof u.base === "string" && u.base.trim()) return u; } catch { /* ignore */ }
  return null;
}
function currentUpstreamBase() {
  const o = readUpstreamOverride();
  return (o && o.base ? String(o.base).trim().replace(/\/+$/, "") : WBM_BASE);
}
function currentGatewayKey() {
  const o = readUpstreamOverride();
  return (o && o.gatewayKey ? String(o.gatewayKey) : WBM_GATEWAY_KEY);
}
/** 目录同步用的地址（10-18）：`db.upstream.catalogBase` 优先（可选，留空 ⇒ 用上游地址），
    再回落上游地址，最后回落环境变量。
    ⛔ 为什么单独一个字段：上游「网关」（调用）与「管理器」（拉目录）不一定是同一个服务 ——
       他人部署时两者常在不同域名/端口，只给一个地址就会出现「能调用但拉不到目录」。 */
function currentCatalogBase() {
  const o = readUpstreamOverride();
  const own = o && o.catalogBase ? String(o.catalogBase).trim().replace(/\/+$/, "") : "";
  return own || currentUpstreamBase();
}
/** 地址归一化（10-18 用户令「协议适配性尽可能强，以兼容更多协议类型」）：
    · 接受 `https://` / `http://` / **裸主机**（`api.example.com` ⇒ 自动补 https）
    · 允许内网与回环地址（部署在自己机器/内网时是常态）、自定义端口、任意路径前缀
    · 统一去尾部斜杠，丢弃 query/hash（拼探测路径时它们只会添乱）
    ⛔ 只接受 http(s)：上游是 HTTP API，ws/ftp/file 等一律拒绝并说明原因。
    ⛔ http 只打 `insecure` 标记**不拒绝** —— 内网自建场景下它往往是唯一能用的。 */
function normalizeUpstreamBase(input) {
  let raw = String(input == null ? "" : input).trim();
  if (!raw) return { ok: false, error: "地址不能为空" };
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = "https://" + raw;
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: "地址格式不合法（示例：https://api.example.com、http://192.168.1.10:8080、api.example.com/wbm）" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `不支持 ${u.protocol} 协议：上游必须是 http 或 https` };
  }
  if (!u.hostname) return { ok: false, error: "缺少主机名" };
  return { ok: true, base: (u.origin + u.pathname).replace(/\/+$/, ""), insecure: u.protocol === "http:" };
}
/** 把 fetch 的异常翻译成人话（面板直接显示，管理员不必去翻服务器日志） */
function classifyFetchError(error) {
  const msg = String((error && (error.name + ": " + error.message)) || error || "");
  if (/TimeoutError|AbortError|timed? ?out/i.test(msg)) return "超时（8 秒内无响应：地址/端口不对，或被防火墙拦了）";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "DNS 解析失败（域名拼错，或这台服务器没有可用 DNS）";
  if (/CERT|SSL|TLS|self.signed|unable to verify/i.test(msg)) return "TLS/证书错误（自签证书不被信任：改用 http 或换正式证书）";
  if (/ECONNREFUSED/i.test(msg)) return "连接被拒绝（端口没开 / 服务没启动）";
  if (/ECONNRESET/i.test(msg)) return "连接被重置（中间设备拦截，或该端口不是 HTTP 服务）";
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return "网络不可达（IP 不在同一网段，或路由没通）";
  return msg || "未知错误";
}
/** HTTP 状态码 → 人话 */
function explainProbeStatus(status) {
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：密钥不对或没带`;
  if (status === 404) return "端点不存在（HTTP 404）：该地址上没有这个接口，检查是否少了路径前缀";
  if (status === 405) return "方法不允许（HTTP 405）：路由在，只是不接受 GET";
  if (status === 429) return "被限流（HTTP 429）：稍后重试";
  if (status >= 500) return `上游内部错误（HTTP ${status}）`;
  if (status >= 400) return `请求被拒（HTTP ${status}）`;
  return `HTTP ${status}`;
}
/** 探测单个端点（**只发 GET**）：返回 { ok, status, ms, count, hint }。
 *  ⛔ 上游测试与知识库/记忆测试**共用这一份** —— 两处各写一份必然漂移。
 *  `authHeader`：`"x-api-key"`（WeKnora 租户 API Key）或 `"bearer"`（网关密钥）。 */
async function probeGet(base, probe, key, authHeader) {
  const t0 = Date.now();
  const headers = key
    ? (authHeader === "x-api-key" ? { "X-API-Key": key } : { Authorization: `Bearer ${key}` })
    : {};
  try {
    const r = await fetch(base + probe.path, { headers, signal: AbortSignal.timeout(8000) });
    const text = await r.text().catch(() => "");
    let count = null;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j && j.data)) count = j.data.length;         // OpenAI 形状
      else if (Array.isArray(j && j.list)) count = j.list.length;     // WBM 形状
      else if (Array.isArray(j && j.models)) count = j.models.length;
      else if (Array.isArray(j && j.items)) count = j.items.length;
    } catch { /* 非 JSON 不致命：能连通但格式不认 */ }
    return {
      name: probe.name, path: probe.path, ok: r.ok, status: r.status,
      ms: Date.now() - t0, count,
      hint: r.ok ? (count == null && probe.wantList ? "能连通，但没解析出列表（端点存在、格式不同）" : "") : explainProbeStatus(r.status),
    };
  } catch (error) {
    return { name: probe.name, path: probe.path, ok: false, status: 0, ms: Date.now() - t0, count: null, hint: classifyFetchError(error) };
  }
}
/** 一组探测里挑"最好的那个"：有模型数的优先，其次能连通的 */
function bestProbe(results) {
  return results.find((x) => x.ok && x.count != null) || results.find((x) => x.ok) || null;
}
/** 客户端要用的"供应商地址"= 本服务同源代理路径（⛔ 不下发上游真实地址）。 */
const BUILTIN_PROXY_PATH = "/cloud-api/proxy/v1";
/** 模型目录缓存时长（WBM 自己也有 5 分钟缓存；这里更宽，避免频繁拉） */
const MODEL_SYNC_TTL_MS = 30 * 60_000;
/* 目录里要**剔除**的模型 id：`auto` 由上游自动挑选模型，记账无法判断实际用了哪个
   （用户令「把 auto 模型去了，那个不好判断用了哪个模型」）。以后要屏蔽别的模型往这里加。 */
const EXCLUDED_CATALOG_IDS = new Set(["auto"]);
/** 内置供应商在客户端的稳定 id 与展示名 */
const BUILTIN_PROVIDER_ID = "limited-benefit";
const BUILTIN_PROVIDER_NAME = "限时福利";
const ALLOWED_ORIGINS = (process.env.HARNESS_ACCOUNTS_ORIGINS || "https://ppz123.asia,https://www.ppz123.asia").split(",");
const SESSION_TTL_MS = 7 * 24 * 3600_000;

/* ── 存储（原子写 + 600 权限）────────────────────────────────────────────── */
let db = { users: [], sessions: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* 首次运行 */ }

/* ── 知识库 / 记忆空间的上游配置（10-18 用户令「预留可配置的接口，以便我自行配置飞牛OS」）──
   db.services = {
     kb:     { base, key, llmModelId, embedModelId, vlmModelId },
     memory: { base, proxyBase, key, instance },
   }
   ⛔ 每个字段**留空即回退环境变量/凭据** —— 不要"保存时把没填的字段写成空串"，
      否则改一个字段会把其它配置一起抹掉。
   ⛔ 密钥落在 data.json（0600）—— 与 db.upstream.gatewayKey 同级。比凭据文件弱一点，
      但这是让"面板可配"成立的前提（凭据文件只能由运维登服务器写）。
   ⛔ 改完**热生效**（下一次知识库/记忆调用就走新地址），不需要重启服务。 */
if (typeof db.services !== "object" || !db.services) db.services = {};
if (typeof db.services.kb !== "object" || !db.services.kb) db.services.kb = {};
if (typeof db.services.memory !== "object" || !db.services.memory) db.services.memory = {};

/** 把 db.services 覆盖到运行时变量上（启动一次 + 每次保存后一次）。 */
function applyServiceOverrides() {
  const kb = (db.services && db.services.kb) || {};
  const mem = (db.services && db.services.memory) || {};
  const trim = (v) => String(v == null ? "" : v).trim();
  WEKNORA_BASE = trim(kb.base).replace(/\/+$/, "") || WEKNORA_ENV_BASE;
  WEKNORA_ADMIN_KEY = trim(kb.key) || WEKNORA_ENV_ADMIN_KEY;
  WEKNORA_LLM_MODEL_ID = trim(kb.llmModelId) || WEKNORA_ENV_MODEL_IDS.llm;
  WEKNORA_EMBED_MODEL_ID = trim(kb.embedModelId) || WEKNORA_ENV_MODEL_IDS.embed;
  WEKNORA_VLM_MODEL_ID = trim(kb.vlmModelId) || WEKNORA_ENV_MODEL_IDS.vlm;
  MEMHUB_BASE = trim(mem.base).replace(/\/+$/, "") || MEMHUB_ENV_BASE;
  MEMHUB_PROXY_BASE = trim(mem.proxyBase).replace(/\/+$/, "") || MEMHUB_ENV_PROXY_BASE;
  MEMHUB_ADMIN_KEY = trim(mem.key) || MEMHUB_ENV_ADMIN_KEY;
  MEMHUB_INSTANCE = trim(mem.instance) || MEMHUB_ENV_INSTANCE;
}
applyServiceOverrides();
if (!Array.isArray(db.users)) db.users = [];
if (typeof db.sessions !== "object" || !db.sessions) db.sessions = {};
if (!db.registerIps || typeof db.registerIps !== "object") db.registerIps = {};
if (!db.invites || typeof db.invites !== "object") db.invites = {};
function persist() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

/* ── 密码与会话 ──────────────────────────────────────────────────────────── */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}
function makeUser(username, password, role) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { username, role: role || "user", salt, hash: hashPassword(password, salt), createdAt: Date.now(), disabled: false, failCount: 0, lockUntil: 0, lastLogin: 0 };
}
function verifyPassword(user, password) {
  const actual = Buffer.from(user.hash, "hex");
  const presented = Buffer.from(hashPassword(password, user.salt), "hex");
  return actual.length === presented.length && crypto.timingSafeEqual(actual, presented);
}
function issueSession(username) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions[crypto.createHash("sha256").update(token).digest("hex")] = { username, exp: Date.now() + SESSION_TTL_MS };
  // 顺手清过期会话
  const now = Date.now();
  for (const [hash, session] of Object.entries(db.sessions)) if (session.exp < now) delete db.sessions[hash];
  persist();
  return token;
}
function sessionUser(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const session = db.sessions[crypto.createHash("sha256").update(token).digest("hex")];
  if (!session || session.exp < Date.now()) return null;
  const user = db.users.find((u) => u.username === session.username);
  return user && !user.disabled ? user : null;
}

/* ── 配对票据（10-13：把「账号」变成配对的前置条件）─────────────────────────
   背景与边界：账号服务原本只管"网站身份"，与各用户本机的配对链路**毫无连接** ——
   于是"先在网页注册"只是网页自己的门，从本机侧可以完全绕开（本机 URL + 控制台自动链接）。
   现在补一层**票据**：网页用账号会话换一张一次性票据 → 用户本机拿它来核销 → 本机凭回执决定放行。

   ⛔ 为什么必须是"本机反向核销"而不是"网页转述"：网页代码完全在用户手里
      （改 localStorage、直接 curl 本机 127.0.0.1 的接口都行），它说的"我登录了"一文不值。
      唯一可信的是**账号服务自己给的回执**。

   · 票据 32B 随机、**一次性**、TTL 120 秒、绑定 username；服务端只存 sha256；
   · 核销即作废（usedAt）⇒ 重放返回 `used`；
   · 核销时**重新校验账号状态** ⇒ 被停用的账号连新配对都拿不到；
   · ⛔ 不做服务间共享密钥：**票据本身就是凭证**（32B 随机 + 一次性 + 限速），
     与它替代的配对码同一信任模型；将来若要更强的机机互信，在这里加 `x-harness-service` 即可。
   ⛔ 票据绝不写日志（与 token / 配对码 同口径）。 */
const TICKET_TTL_MS = 120_000;
if (typeof db.tickets !== "object" || !db.tickets) db.tickets = {};
function pruneTickets() {
  const now = Date.now();
  for (const [hash, entry] of Object.entries(db.tickets)) if (entry.exp < now) delete db.tickets[hash];
}
function issueTicket(username) {
  pruneTickets();
  const ticket = crypto.randomBytes(32).toString("hex");
  const exp = Date.now() + TICKET_TTL_MS;
  db.tickets[crypto.createHash("sha256").update(ticket).digest("hex")] = { username, exp, usedAt: 0 };
  persist();
  return { ticket, exp };
}
/** 核销：成功即作废。失败原因**分档**（本机侧要据此区分"码错"与"账号问题"，不能混成一句话）。 */
function verifyTicket(ticket) {
  pruneTickets();
  const raw = String(ticket || "").trim();
  if (!raw) return { ok: false, reason: "unknown" };
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const found = db.tickets[hash];
  if (!found) return { ok: false, reason: "unknown" };
  if (found.usedAt) return { ok: false, reason: "used" };
  if (found.exp < Date.now()) { delete db.tickets[hash]; persist(); return { ok: false, reason: "expired" }; }
  const user = db.users.find((u) => u.username === found.username);
  if (!user || user.disabled) return { ok: false, reason: "account-disabled" };
  found.usedAt = Date.now();
  persist();
  return { ok: true, username: found.username };
}

/* ── 设备绑定（10-13 二期）：本机码 → 云端匹配 → 下发设备 token ─────────────
   流程（方案 A+ 的第一块地基 —— 账号开始有实际价值）：
     ① 本机生成配对码并显示（本机负责生成，这一步永远离线）；
     ② 用户在网页注册/登录后提交这个码（认领）；
     ③ 服务端把「账号 ⟷ 本机码」绑定并生成**设备 token**（32B 随机，只存 sha256）；
     ④ 本机轮询拿走 token → 存本机 ⇒ 允许连接服务器（拉更新 / 将来的云功能）。

   ⛔ 信任模型与配对码一致：**码即凭据**（8 位十六进制 + 认领需网页会话）。
   ⛔ 同码重复认领 = 重装/换机场景 ⇒ 重新生成 token（旧 token 立即失效）。
   ⛔ token 绝不写日志；服务端只存 sha256。 */
if (typeof db.devices !== "object" || !db.devices) db.devices = {};   // codeHash → 设备记录
/* 模型目录缓存：{ syncedAt, realm, source, list: [...] } —— 由 WBM 同步而来 */
if (typeof db.modelCatalog !== "object" || !db.modelCatalog) db.modelCatalog = { syncedAt: 0, realm: "cn", source: "", list: [] };
/* 每用户生效模型：username → [modelId]（空/缺省 = 全不启用，由用户勾选决定） */
if (typeof db.userModels !== "object" || !db.userModels) db.userModels = {};
/* ── 闲时（限时）倍率（10-18 用户令「加一个限时倍率，管理员可以修改倍率」）────────
   db.offPeak = { enabled, rateSemantics, windows: [ { id, label, start, end, rate } ] }
   ⛔⛔ 语义（10-18 二次修正，用户原话「不是我填 0.5 就打 5 折，前面 0.11 后面闲时我可以填 0.05」）：
      `rate` 是**该时段的默认倍率**，命中时段直接**替换**模型倍率 —— 高峰 ×0.11、闲时填 0.05
      ⇒ 闲时按 ×0.05 计费（**不是** 0.11×0.05）。
      `rate: null`（留空）= 该时段不设默认倍率 ⇒ 落各模型自己的 `offPeakRate`；都没设 ⇒ 沿用高峰倍率。
   ⛔ 不改模型倍率本身（那只存一份真相源：目录里的 credits）。
   ⛔ 时段判定用**服务端本地时间**（CST）；`start > end` 视为跨零点（如 22→6）。
   ⛔ 默认 enabled=false ⇒ 不改动任何既有计费行为，等管理员显式开启。 */
if (typeof db.offPeak !== "object" || !db.offPeak) {
  db.offPeak = {
    enabled: false,
    rateSemantics: "replace-v1",
    windows: [
      { id: "night", label: "夜间", start: 0, end: 8, rate: null },
      { id: "offpeak", label: "闲时", start: 18, end: 24, rate: null },
    ],
  };
}
/* ⛔⛔ 一次性语义迁移（10-18）：旧版的 `windows[].rate` 是**折扣系数**（0.5 = 5 折），
   新版是**直接倍率** —— 原样沿用会把正常 ×0.11 的模型按 ×0.5 计费（涨 4.5 倍，用户会炸）。
   所以这里无条件清空旧值，由管理员在面板上按新语义重填。⛔ 只跑一次（靠 rateSemantics 标记），
   否则管理员填的新倍率会在每次重启时被清掉。 */
if (db.offPeak.rateSemantics !== "replace-v1") {
  const old = Array.isArray(db.offPeak.windows) ? db.offPeak.windows : [];
  for (const w of old) { if (w) delete w.rate; }
  db.offPeak.rateSemantics = "replace-v1";
  persist();
  console.log(`[accounts] 闲时倍率语义迁移：已清空 ${old.length} 个时段上的旧「折扣系数」值（系数≠倍率，请在面板按新语义重填）`);
}
/* ── 积分账本（10-14）──────────────────────────────────────────────────────
   db.points = { "<username>": { balance, txns: [ {id, at, delta, kind, ref, note, after} ] } }
   ⛔ 流水是唯一真相源，balance 是它的累加；ref 唯一 ⇒ 同一件事只入账一次（幂等）。
   ⛔ 消耗数值**取自 WBM 返回的 usage.credit**（不是本地估的）⇒ 天然与 WBM 口径同步。 */
if (typeof db.points !== "object" || !db.points) db.points = {};
const SIGNUP_GRANT = Number(process.env.HARNESS_SIGNUP_POINTS || 1000);

/* 注册反滥用（10-16 用户令「注册云端账号，看看加一个什么限制合适，防止被滥用」）。
   三层，从宽到严：
     ① 每 IP 每小时 3 次（原有）—— 压速率，防脚本连刷；
     ② **每 IP 累计上限**（REGISTER_MAX_PER_IP，默认 5）—— 压总量。
        ⛔ 这才是根治：时限限流只让脚本"慢一点"，换个小时接着刷就是了；
        累计上限才真正封掉"一台机器批量开号领注册赠送"这条滥用路径。
     ③ **可选邀请码**（REGISTER_INVITE_CODE，留空 = 不要求）—— 需要严控时改一行环境变量即可切过去，
        不必改代码。
   ⛔ 计数只落 `db.registerIps`（IP → 次数），不记时间序列 —— 只用于判定，不做用户画像。 */
const REGISTER_MAX_PER_IP = Number(process.env.HARNESS_REGISTER_MAX_PER_IP || 5);
const REGISTER_INVITE_CODE = String(process.env.HARNESS_REGISTER_INVITE_CODE || "").trim();
const POINTS_TXN_KEEP = 200;                         // 每人保留的流水条数（防无限增长）
function pointsOf(username) {
  const key = String(username || "");
  if (!db.points[key]) db.points[key] = { balance: 0, txns: [] };
  if (!Array.isArray(db.points[key].txns)) db.points[key].txns = [];
  return db.points[key];
}
/** 入账：ref 幂等（同 ref 只记一次）。返回 { changed, balance, txn } */
function addPoints(username, delta, kind, ref, note) {
  const acct = pointsOf(username);
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return { changed: false, balance: acct.balance, txn: null };
  if (ref && acct.txns.some((t) => t.ref === ref)) return { changed: false, balance: acct.balance, txn: null };
  acct.balance = Math.round((acct.balance + d) * 100) / 100;
  const txn = { id: acct.txns.length + 1, at: Date.now(), delta: d, kind: String(kind || "adjust"), ref: String(ref || ""), note: String(note || "").slice(0, 200), after: acct.balance };
  acct.txns.unshift(txn);
  if (acct.txns.length > POINTS_TXN_KEEP) acct.txns.length = POINTS_TXN_KEEP;
  return { changed: true, balance: acct.balance, txn };
}
/**
 * 只落一条流水、**不动余额** —— 免费模型调用留痕专用（10-14 用户令
 * 「免费的模型，只要调用了，就要有记录，我看免费的模型没有出来调用记录」）。
 *
 * ⛔ 为什么不直接用 addPoints：它承担的是**余额变更**，`d === 0` 是它的合法短路
 *    （余额没变就不该产生一条"变动"记录）；而这里要的恰恰是相反语义 ——
 *    **余额不变，但调用事实必须留痕**。两者语义不同，硬塞进一个函数会让
 *    「注册赠送 / 手工调整」等其它调用方也开始落 0 值垃圾记录。
 * ⛔ delta 恒为 0 ⇒ 不参与 pointsVerify 的求和 ⇒ 账目一致性判定不受影响。
 */
function addUsageOnly(username, kind, ref, note) {
  const acct = pointsOf(username);
  if (ref && acct.txns.some((t) => t.ref === ref)) return { changed: false, balance: acct.balance, txn: null };
  const txn = {
    id: acct.txns.length + 1, at: Date.now(), delta: 0,
    kind: String(kind || "consume"), ref: String(ref || ""),
    note: String(note || "").slice(0, 200), after: acct.balance,
  };
  acct.txns.unshift(txn);
  if (acct.txns.length > POINTS_TXN_KEEP) acct.txns.length = POINTS_TXN_KEEP;
  return { changed: true, balance: acct.balance, txn };
}
/** 自查：balance 必须等于流水之和（对不上说明有并发或手改） */
function pointsVerify(username) {
  const acct = pointsOf(username);
  const sum = Math.round(acct.txns.reduce((n, t) => n + Number(t.delta || 0), 0) * 100) / 100;
  return { balance: acct.balance, sum, ok: Math.abs(sum - acct.balance) < 0.005 };
}

/* 每用户代理令牌：username → { hash, prefix, createdAt, lastUsedAt, ips: [] }
   ⛔ 库内**只存 sha256**，明文仅签发时返回一次（与 WBM 的 api_tokens 同一形态）；
   ⛔ 它不是上游网关密钥 —— 上游密钥只在服务端由代理注入，客户端永远拿不到。 */
if (typeof db.proxyTokens !== "object" || !db.proxyTokens) db.proxyTokens = {};
const PROXY_TOKEN_PREFIX = "wap_";
/* ⛔ 20:2x 用户令「不要被人家破解拿去用」：来源绑定从 5 收紧到 **1** ——
   令牌**只在首次使用的那个网络/IP** 可用，换个网络立刻拒（提示重新签发）。
   真实上游地址与网关密钥始终只在服务端（客户端只拿得到 /cloud-api/proxy 这类代理路径）。 */
const PROXY_IP_LIMIT = 1;
/* 令牌环深度：同时有效的令牌把数（含当前这把）。默认 3。
   ⛔ 为什么要有环：明文只在签发时返回一次、库里只存 sha256 ⇒ **取不回旧令牌**，
   而外部消费者（记忆网关的 yaml 等）存的是快照 ⇒ 轮换一次就断一次（10-16 实测踩到，
   表现是记忆恒 401 invalid-proxy-token）。有环之后旧副本在若干轮内仍可用 ⇒ 能自愈。
   ⛔ 环只影响"还能不能用"，**不影响来源绑定**（ips 仍属同一条记录、同一套规则）。 */
const PROXY_TOKEN_RING = Math.max(1, Math.min(10, Number(process.env.HARNESS_PROXY_TOKEN_RING || 3) || 3));
function pushRing(row, ring) {
  if (!row) return [];
  const list = Array.isArray(row.prevHashes) ? row.prevHashes.slice() : [];
  if (row.hash) {
    list.unshift({ hash: row.hash, createdAt: Number(row.createdAt || 0) });
    while (list.length > Math.max(0, ring - 1)) list.pop();
  }
  return list;
}
function hashProxyToken(t) { return crypto.createHash("sha256").update(String(t || "")).digest("hex"); }
function proxyUserByToken(t) {
  const h = hashProxyToken(t);
  for (const [username, row] of Object.entries(db.proxyTokens)) {
    if (!row) continue;
    if (row.hash === h) return { username, row, viaRing: false };
    /* 令牌环：轮换前后的旧令牌在窗口内仍可用（外部快照副本靠它自愈） */
    if (Array.isArray(row.prevHashes) && row.prevHashes.some((p) => p && p.hash === h)) return { username, row, viaRing: true };
  }
  return null;
}
const DEVICE_CODE_RE = /^[0-9a-f]{8}$/;
/** 服务端密钥（HMAC 派生设备 token 用）：首次运行自动生成并落盘（0600）。
 *  ⛔ 为什么用派生而不是随机+存库：本机要靠**轮询**拿 token，而库里只存 sha256
 *     （拖库不泄露凭据）⇒ token 必须**可由服务端重算**。HMAC(serverSecret, code) 兼顾两者：
 *     库泄露拿不到 token；换 secret = 全部设备 token 同时失效（等于全员重配对，语义也正确）。 */
function serverSecret() {
  const secretFile = path.join(path.dirname(DATA_FILE), "secret.key");
  try { return fs.readFileSync(secretFile, "utf8").trim(); } catch { /* 首次运行 */ }
  const secret = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(secretFile, secret, { mode: 0o600 }); } catch (error) { console.error("[accounts] 密钥落盘失败：", error.message); }
  return secret;
}
/** 设备 token 派生基准：`mid:<机器标识>`（机器稳定、重配对不变）或 `code:<配对码>`（兼容旧记录）。
 *  ⛔ 仍然只存 sha256(token)：库泄露同样拿不到 token（基准不落库，只由记录里的 machineId/code 现算）。 */
function deviceTokenBaseOf(device) {
  const mid = String(device && device.machineId || "").trim();
  return mid ? "mid:" + mid : "code:" + String(device && device.code || "").trim().toLowerCase();
}
function deviceTokenOf(base) {
  return crypto.createHmac("sha256", serverSecret()).update(`device:${String(base || "").trim().toLowerCase()}`).digest("hex");
}
function deviceCodeHash(code) { return crypto.createHash("sha256").update(String(code || "").trim().toLowerCase()).digest("hex"); }
function deviceIdOf(codeHash) { return codeHash.slice(0, 8); }
/* ── 云端同步存储（P0：会话上传 + 索引；按账号分目录落盘） ─────────────────
   布局：<SYNC_DIR>/<username>/sessions/<sessionId>.jsonl  +  <SYNC_DIR>/<username>/index.json
   ⛔ 与本地 rollout 同构（逐行可比）；索引只存元数据（标题/项目/机器/时间/字节数/行数）。 */
function syncUserDir(username) { return path.join(SYNC_DIR, String(username || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_")); }
function syncIndexFile(username) { return path.join(syncUserDir(username), "index.json"); }
function readSyncIndex(username) {
  try { const raw = JSON.parse(fs.readFileSync(syncIndexFile(username), "utf8")); return raw && typeof raw === "object" ? raw : {}; }
  catch { return {}; }
}
function writeSyncIndex(username, index) {
  const dir = syncUserDir(username);
  try { fs.mkdirSync(path.join(dir, "sessions"), { recursive: true }); fs.writeFileSync(syncIndexFile(username), JSON.stringify(index)); return true; }
  catch (error) { console.error("[sync] 索引写入失败：", error.message); return false; }
}
/** 已用字节（索引累加，避免每次扫盘）。 */
function syncUsageBytes(username) {
  const index = readSyncIndex(username);
  let total = 0;
  for (const row of Object.values(index)) total += Number(row && row.sizeBytes || 0);
  return total;
}
function listDevices(username) {
  const out = [];
  for (const [hash, device] of Object.entries(db.devices)) {
    if (device.username !== username) continue;
    out.push({ id: deviceIdOf(hash), name: device.name, claimedAt: device.claimedAt, lastSeen: device.lastSeen || 0 });
  }
  return out.sort((a, b) => b.claimedAt - a.claimedAt);
}
/** 认领：码 + 网页会话 ⇒ 绑定账号。token 由服务端密钥派生（见 serverSecret 头注）。
 *  同码重复认领 = 重装/换机 ⇒ 绑定刷新（token 不变，因为它只由码派生）。 */
function claimDevice(code, username, name, machineId) {
  const raw = String(code || "").trim().toLowerCase();
  if (!DEVICE_CODE_RE.test(raw)) return { ok: false, reason: "bad-code" };
  const hash = deviceCodeHash(raw);
  /* ⛔ 每账号最多 DEVICE_LIMIT 台（10-14 用户令）。判重按 machineId：同一台机器重新配对不算新增
     （认领时会替换同机旧记录），所以先算出"去掉本机后还剩几台"。 */
  const mid0 = String(machineId || "").trim().slice(0, 64);
  const others = Object.values(db.devices).filter((d) => d.username === username && (!mid0 || d.machineId !== mid0)).length;
  if (others >= DEVICE_LIMIT) return { ok: false, reason: "device-limit", limit: DEVICE_LIMIT, current: others };
  /* ⛔ 一台机器恒一条记录（10-14 用户实测：面板里堆了 6 条"我的电脑"）：认领带本机稳定标识
     （installation_id）⇒ 先把**同一台机器**的旧记录删掉再写新的 = 重配对即更新。 */
  const mid = String(machineId || "").trim().slice(0, 64);
  if (mid) {
    for (const [oldHash, device] of Object.entries(db.devices)) {
      if (oldHash !== hash && device.machineId === mid) { delete db.devices[oldHash]; delete db.deviceCodes?.[oldHash]; }
    }
  }
  const prev = db.devices[hash];
  db.devices[hash] = {
    username,
    name: String(name || "").trim().slice(0, 32) || `设备-${deviceIdOf(hash)}`,
    code: raw,
    machineId: mid || prev?.machineId || "",
    tokenHash: crypto.createHash("sha256").update(deviceTokenOf(mid ? "mid:" + mid : "code:" + raw)).digest("hex"),
    claimedAt: prev?.claimedAt || Date.now(),
    lastSeen: prev?.lastSeen || 0,
  };
  persist();
  return { ok: true, device: { id: deviceIdOf(hash), name: db.devices[hash].name, token: deviceTokenOf(raw), rebound: Boolean(prev) } };
}
/** 入网核销：本机拿码换设备 token（轮询用；码即凭据）。⛔ 账号被停用 ⇒ 拒绝。 */
function redeemDeviceCode(code) {
  const raw = String(code || "").trim().toLowerCase();
  if (!DEVICE_CODE_RE.test(raw)) return { ok: false, claimed: false, reason: "unknown" };
  const device = db.devices[deviceCodeHash(raw)];
  if (!device) return { ok: false, claimed: false };
  const user = db.users.find((u) => u.username === device.username);
  if (!user || user.disabled) return { ok: false, claimed: true, reason: "account-disabled" };
  device.lastSeen = Date.now();
  persist();
  return { ok: true, claimed: true, username: device.username, name: device.name, id: deviceIdOf(deviceCodeHash(raw)), token: deviceTokenOf(deviceTokenBaseOf(device)) };
}
/** 凭设备 token 找设备（tokenHash 反查；db.devices 的键是 code+token 的组合哈希）。 */
function findDeviceByToken(token) {
  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  for (const device of Object.values(db.devices)) if (device.tokenHash === hash) return device;
  return null;
}
/** 更新通道元数据（服务器管理员维护的 updates.json；没有就视为已最新）。 */
function readUpdateMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(DATA_FILE), "updates.json"), "utf8"));
    return {
      available: Boolean(raw.available),
      latest: String(raw.latest || ""),
      url: String(raw.url || ""),
      notes: String(raw.notes || ""),
    };
  } catch { return { available: false, latest: "", url: "", notes: "" }; }
}
/** 吊销：删除设备（token 随之失效）。 */
function revokeDevice(username, id) {
  for (const [hash, device] of Object.entries(db.devices)) {
    if (device.username === username && deviceIdOf(hash) === String(id || "")) {
      delete db.devices[hash];
      persist();
      return true;
    }
  }
  return false;
}

/* ── 限速 ────────────────────────────────────────────────────────────────── */
const buckets = new Map();   // key → { count, resetAt }
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  bucket.count += 1;
  return bucket.count <= max;
}
function ipOf(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }

/** 本服务**对外**基址（客户端据此把「服务地址」同步成服务器上真实的那个）。
 *  ⛔ 必须走反代头：本站是 Caddy/Nginx 反代，进程里的 req.headers.host 是内网地址；
 *     ⛔ 也不硬编码域名 —— 换域名/换端口就错，那正是本函数要解决的问题。 */
function publicBaseOf(req) {
  const proto = String((req.headers["x-forwarded-proto"] || "https")).split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (host) return `${proto}://${host}/cloud-api`;
  return String(process.env.PUBLIC_BASE || "").replace(/\/+$/, "");
}

/* ── 邀请码（10-16 用户令「注册来源可监控 + 每码额度可管」）───────────────────
   模型：一个码可被 N 个账号使用；账号侧只留 inviteCode **指针**（⛔ 不反向存整个对象 = 单一真相源）。
   细则（字段范围 / 判定顺序 / 展示方式）见 docs/CLOUD-INVITE-CODES.md。 */
const INVITE_CODE_RE = /^[0-9a-f]{8}$/;
/** 归一化：去空白 + 转小写 + 只留十六进制字符。⛔ 不做"自动纠错到相似码"（会让人误用别人的码）。 */
function normalizeInvite(value) {
  return String(value || "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
}
function inviteRow(code) {
  const key = normalizeInvite(code);
  return key && INVITE_CODE_RE.test(key) && db.invites[key] ? db.invites[key] : null;
}
/** 码是否还能注册；返回原因码（空串 = 可用）。⛔ 原因里**不含剩余额度**。 */
function inviteBlocker(row) {
  if (!row) return "invite-not-found";
  if (row.disabled) return "invite-disabled";
  if (Number(row.expiresAt || 0) !== 0 && Date.now() >= Number(row.expiresAt)) return "invite-expired";
  if (Number(row.maxUses || 0) !== 0 && Number(row.usedCount || 0) >= Number(row.maxUses)) return "invite-exhausted";
  return "";
}
const INVITE_REASON_TEXT = {
  "invite-required": "需要邀请码：请向管理员索取后再注册",
  "invite-not-found": "邀请码不存在",
  "invite-disabled": "该邀请码已停用",
  "invite-expired": "该邀请码已过期",
  "invite-exhausted": "该邀请码的注册名额已用完",
};
/** 管理端视图：附派生字段 —— 前端不再自己算时间/余量。 */
function inviteView(row) {
  const used = Number(row.usedCount || 0);
  const maxUses = Number(row.maxUses || 0);
  const expiresAt = Number(row.expiresAt || 0);
  return {
    code: row.code,
    note: row.note || "",
    createdBy: row.createdBy || "",
    createdAt: Number(row.createdAt || 0),
    maxUses,
    usedCount: used,
    /* null = 不限量（前端据此不画进度条） */
    remaining: maxUses === 0 ? null : Math.max(0, maxUses - used),
    /* ⛔ 与 usedCount **并列**展示：两者不等 = 有账号被删过（这本身是有用信号） */
    registeredCount: db.users.filter((u) => u.inviteCode === row.code).length,
    disabled: Boolean(row.disabled),
    expiresAt,
    expired: expiresAt !== 0 && Date.now() >= expiresAt,
    lastUsedAt: Number(row.lastUsedAt || 0),
  };
}
function inviteList() {
  return Object.values(db.invites).map(inviteView).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
/** 是否强制要邀请码：**表非空 ∥ 配了主码**。
 *  ⛔ 两者都空 ⇒ 回归开放注册 —— 否则全新部署一个码都没有，谁也注册不了（把自己锁在门外）。 */
function inviteRequired() {
  return Object.keys(db.invites).length > 0 || Boolean(REGISTER_INVITE_CODE);
}

/* ── 路由 ────────────────────────────────────────────────────────────────── */
function usernameOk(name) { return /^[A-Za-z0-9_-]{3,24}$/.test(String(name || "")); }
function passwordOk(pw) { return typeof pw === "string" && pw.length >= 8 && pw.length <= 128; }
function publicView(user) {
  return { username: user.username, role: user.role, createdAt: user.createdAt, disabled: user.disabled, lastLogin: user.lastLogin || 0 };
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  // ⛔ 服务端硬闸：带 Origin 的请求必须来自站点自身。只回空 CORS 头是不够的 ——
  //   那只靠浏览器拦截，curl/脚本直连就绕过了（真实测试里 evil origin 注册成功过）。
  //   无 Origin = 非浏览器发起，放行（服务本机自检用）。
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "origin-not-allowed" }));
    return;
  }
  const cors = ALLOWED_ORIGINS.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600", Vary: "Origin" } : {};
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cors }); res.end(JSON.stringify(body)); };
  /* ── 版本与更新（10-18 用户令「云端管理加一个更新功能」）────────────────
     ⛔⛔ 必须放在 `send` 定义**之后** —— 放前面会踩 `const` 暂时性死区（TDZ），
        handler 抛 ReferenceError、连接直接断，`curl` 只看到空响应（实测踩过）。
     ⛔ **公开**端点（无需鉴权）：面板、运维脚本、监控都要能读到当前版本。
     ⛔ 只回版本与仓地址，**不回**任何配置/密钥/路径。 */
  if (p === "/api/version" && req.method === "GET") {
    return send(200, {
      ok: true,
      name: "codex-cloud-assistant",
      version: APP_VERSION,
      repo: DEPLOY_REPO,
      deployRepo: DEPLOY_REPO,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
    });
  }
  /* ── 检查更新（10-18 用户令「加上国内镜像更新」）──────────────────────────
     ⛔ 为什么不在浏览器里查 GitHub：
        ① 匿名 API 限 **60 次/小时/IP**，超了就是 **403** —— 很容易被误读成"被墙"
           （实测：面板点「检查更新」直接 403，提示语也写错了）；
        ② 国内浏览器直连 github.com / api.github.com 经常超时。
     ⇒ 由**服务端**依次试「直连 + 国内镜像」的 **raw 文件**：raw 不计 API 配额，
        镜像只做透传。⛔ 只读一个 VERSION 文本，不拉代码、不执行任何东西。 */
  if (p === "/api/updates" && req.method === "GET") {
    const rawUrl = DEPLOY_REPO.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/main/VERSION";
    const probeOne = async (m) => {
      const t0 = Date.now();
      try {
        /* ⛔ 带时间戳 query：镜像/CDN 会缓存 raw 文件，不加更容易读到上一版 */
        const r = await fetch(m.prefix + rawUrl + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000), headers: { "Cache-Control": "no-cache" } });
        const text = r.ok ? (await r.text()).trim() : "";
        const latest = (text.match(/^v?\d+\.\d+\.\d+/) || [])[0] || "";
        return { name: m.name, ok: Boolean(latest), status: r.status, ms: Date.now() - t0, latest, error: latest ? "" : explainProbeStatus(r.status) };
      } catch (error) {
        return { name: m.name, ok: false, status: 0, ms: Date.now() - t0, latest: "", error: classifyFetchError(error) };
      }
    };
    /* ⛔⛔ **并行问所有源、取最高版本** —— 不能"第一个成功就返回"：
       镜像缓存滞后会给出**旧**版本（实测：ghfast 返 1.0.2，而 gh-proxy 与直连已是 1.0.3）。
       总耗时 ≈ 最慢那个（≤6s），比"问到旧版就停"正确得多。 */
    const tried = await Promise.all(UPDATE_MIRRORS.map(probeOne));
    const good = tried.filter((t) => t.ok);
    if (!good.length) {
      return send(200, { ok: false, current: APP_VERSION, tried, repo: DEPLOY_REPO, message: "所有源都失败（含国内镜像）—— 直接打开仓库页看最新 tag" });
    }
    const best = good.reduce((a, b) => (cmpVersion(b.latest, a.latest) > 0 ? b : a));
    return send(200, {
      ok: true, current: APP_VERSION,
      latest: best.latest, source: best.name,
      /* 各源分别读到什么，面板可据此发现"某个镜像滞后" */
      sources: good.map((x) => `${x.name}=${x.latest}`),
      tried, repo: DEPLOY_REPO,
    });
  }
  const readBody = () => new Promise((resolve, reject) => {
    let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 64 * 1024) { reject(new Error("too-large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error("bad-json")); } });
    req.on("error", reject);
  });
  /** 大 body 读取（同步上传用）：默认 readBody 限 64KB，会话批次远超 —— 单次上限 32MB。 */
  const readBodyLarge = (limit = 32 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too-large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { const raw = Buffer.concat(chunks).toString("utf8"); resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error("bad-json")); } });
    req.on("error", reject);
  });
  const ip = ipOf(req);

  try {
    /* 注册 */
    if (p === "/register" && req.method === "POST") {
      if (!rateLimit(`reg:${ip}`, 3, 3600_000)) return send(429, { ok: false, error: "注册太频繁，请一小时后再试" });
      /* ② 每 IP 累计上限（见常量处说明：时限限流压速率，这条压总量） */
      const regCount = Number((db.registerIps && db.registerIps[ip]) || 0);
      if (regCount >= REGISTER_MAX_PER_IP) {
        return send(429, { ok: false, error: "register-ip-limit", message: `这台网络已注册过 ${regCount} 个账号（上限 ${REGISTER_MAX_PER_IP}），如需更多请联系管理员` });
      }
      const body = await readBody();
      /* ③ 邀请码：**表内码优先**（记账 / 额度 / 来源），其次环境变量主码（兜底、不计数）。
         ⛔ 判定必须在这里（读 body 之后、建号之前）—— 失败路径不能留下任何副作用。 */
      const inviteCode = normalizeInvite(body.invite);
      const invite = inviteRow(inviteCode);
      const isMaster = !invite && Boolean(REGISTER_INVITE_CODE) && String(body.invite || "").trim() === REGISTER_INVITE_CODE;
      if (inviteRequired() && !invite && !isMaster) {
        const reason = inviteCode ? "invite-not-found" : "invite-required";
        return send(403, { ok: false, error: reason, message: INVITE_REASON_TEXT[reason] });
      }
      if (invite) {
        const blocker = inviteBlocker(invite);
        if (blocker) return send(403, { ok: false, error: blocker, message: INVITE_REASON_TEXT[blocker] });
      }
      const username = String(body.username || "").trim();
      if (!usernameOk(username)) return send(400, { ok: false, error: "用户名需 3~24 位字母/数字/下划线/连字符" });
      if (!passwordOk(body.password)) return send(400, { ok: false, error: "密码至少 8 位" });
      if (db.users.some((u) => u.username === username)) return send(409, { ok: false, error: "用户名已被占用" });
      const user = makeUser(username, body.password, "user");
      /* 来源指针（"" = 主码或无邀请；历史账号也是 ""）。⛔ 只存码，不存整个码对象。 */
      user.inviteCode = invite ? invite.code : "";
      db.users.push(user);
      /* 新用户注册即赠积分（ref 幂等 ⇒ 同一账号绝不会重复送） */
      addPoints(username, SIGNUP_GRANT, "signup", `signup:${username}`, `注册赠送 ${SIGNUP_GRANT} 积分`);
      if (!db.registerIps) db.registerIps = {};
      db.registerIps[ip] = regCount + 1;
      /* 码上记账：⛔ usedCount 只增不减（否则"注册→删号→再注册"可无限刷额度）；
         usedBy 只是溯源快照，超 200 条不再追加（usedCount 仍准确）。 */
      if (invite) {
        invite.usedCount = Number(invite.usedCount || 0) + 1;
        invite.lastUsedAt = Date.now();
        if (!Array.isArray(invite.usedBy)) invite.usedBy = [];
        if (invite.usedBy.length < 200) invite.usedBy.push(username);
      }
      persist();
      console.log(`[points] 新用户 ${username} 注册，赠送 ${SIGNUP_GRANT} 积分（本 IP 累计 ${db.registerIps[ip]}/${REGISTER_MAX_PER_IP}）`);
      return send(200, { ok: true, token: issueSession(username), account: publicView(user), points: { balance: pointsOf(username).balance, granted: SIGNUP_GRANT } });
    }

    /* 登录 */
    if (p === "/login" && req.method === "POST") {
      if (!rateLimit(`login-ip:${ip}`, 10, 5 * 60_000)) return send(429, { ok: false, error: "尝试过多，请几分钟后再来" });
      const body = await readBody();
      const username = String(body.username || "").trim();
      const user = db.users.find((u) => u.username === username);
      if (!user) return send(401, { ok: false, error: "用户名或密码不对" });
      if (user.disabled) return send(403, { ok: false, error: "该账号已被停用，联系管理员" });
      if (Date.now() < user.lockUntil) return send(429, { ok: false, error: "该账号已被临时锁定，稍后再试" });
      if (!rateLimit(`login-u:${username}`, 5, 15 * 60_000)) {
        user.lockUntil = Date.now() + 15 * 60_000; persist();
        return send(429, { ok: false, error: "失败次数过多，账号锁定 15 分钟" });
      }
      if (!verifyPassword(user, body.password)) {
        user.failCount = (user.failCount || 0) + 1; persist();
        return send(401, { ok: false, error: "用户名或密码不对" });
      }
      user.failCount = 0; user.lastLogin = Date.now(); persist();
      return send(200, { ok: true, token: issueSession(username), account: publicView(user), server: { baseUrl: publicBaseOf(req) } });
    }

    /* 以下都要会话 */
    const me = sessionUser(req);

    /* 配对票据：网页用账号会话换一张一次性票据（这就是"先注册"落成硬约束的那一步） */
    if (p === "/pair-ticket" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      if (!rateLimit(`ticket-ip:${ip}`, 30, 5 * 60_000)) return send(429, { ok: false, error: "请求过于频繁，稍后再试" });
      const { ticket, exp } = issueTicket(me.username);
      return send(200, { ok: true, ticket, expiresAt: exp, username: me.username });
    }
    /* 核销：**用户本机的伴生服务**调用（非浏览器 ⇒ 无 Origin ⇒ 上面的 Origin 闸放行）。
       ⛔ 不要求会话：本机没有账号会话，它只有这张票据。 */
    if (p === "/pair-ticket/verify" && req.method === "POST") {
      if (!rateLimit(`verify-ip:${ip}`, 60, 5 * 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const body = await readBody();
      const result = verifyTicket(body && body.ticket);
      return send(200, result.ok
        ? { ok: true, username: result.username }
        : { ok: false, reason: result.reason });
    }
    /* 账号状态查询：本机侧定时来核销，账号被**停用**后要让已签发的令牌失效
       （否则"停用"只管得住新配对，管不住已经在用的会话）。 */
    if (p === "/pair-ticket/status" && req.method === "GET") {
      if (!rateLimit(`status-ip:${ip}`, 120, 5 * 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const names = String(url.searchParams.get("usernames") || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
      const accounts = {};
      for (const name of names) {
        const user = db.users.find((u) => u.username === name);
        accounts[name] = { exists: Boolean(user), disabled: !user || Boolean(user.disabled) };
      }
      return send(200, { ok: true, accounts });
    }

    /* ── 设备绑定（10-13 二期）：本机码 → 云端匹配 → 下发设备 token ──────────
       这是「账号」从摆设变成有实际价值的第一步：绑定了设备，本机才有资格连服务器
       （拉更新 / 将来的云端会话索引 —— 方案 A+ 的挂点）。 */
    if (p === "/device/claim" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      if (!rateLimit(`claim-ip:${ip}`, 30, 5 * 60_000)) return send(429, { ok: false, error: "请求过于频繁，稍后再试" });
      const body = await readBody();
      const result = claimDevice(body && body.code, me.username, body && body.name, body && body.machineId);
      if (!result.ok && result.reason === "device-limit") {
        return send(409, { ok: false, error: "device-limit", message: `每个账号最多绑定 ${result.limit} 台电脑（当前已有 ${result.current} 台）。请先在用户中心删除一台已绑定机器，再绑定新机器。`, limit: result.limit, current: result.current });
      }
      if (!result.ok) return send(400, { ok: false, error: result.reason });
      return send(200, { ok: true, device: result.device, account: publicView(me) });
    }
    /* 本机轮询：码即凭据（无网页会话）。账号停用 ⇒ 拒绝下发。 */
    /* ⛔ 按**机器**查询认领状态（10-14 修复回调超时）：本机用 installation_id 轮询，
       不再依赖"当前码" —— 用户手填旧码认领时，本机也能凭机器标识接上（码只是握手）。 */
    if (p === "/device/status" && req.method === "GET") {
      const mid = String(url.searchParams.get("machineId") || "").trim().slice(0, 64);
      const code = String(url.searchParams.get("code") || "").trim().toLowerCase();
      let device = null;
      let hitHash = "";
      if (mid) {
        for (const [hash, row] of Object.entries(db.devices)) if (row.machineId === mid) { device = row; hitHash = hash; break; }
      }
      if (!device && DEVICE_CODE_RE.test(code)) {
        const hash = deviceCodeHash(code);
        if (db.devices[hash]) { device = db.devices[hash]; hitHash = hash; }
      }
      if (!device) return send(200, { ok: true, claimed: false });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(200, { ok: true, claimed: true, reason: "account-disabled" });
      device.lastSeen = Date.now();
      persist();
      return send(200, { ok: true, claimed: true, username: device.username, name: device.name, id: deviceIdOf(hitHash), token: deviceTokenOf(deviceTokenBaseOf(device)) });
    }
    if (p === "/device/claim-status" && req.method === "GET") {
      if (!rateLimit(`devstatus-ip:${ip}`, 120, 5 * 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const result = redeemDeviceCode(url.searchParams.get("code"));
      if (!result.claimed) return send(200, { ok: true, claimed: false });
      if (!result.ok) return send(403, { ok: false, error: result.reason });
      return send(200, { ok: true, claimed: true, token: result.token, username: result.username, device: { id: result.id, name: result.name } });
    }
    /* 用户中心：我的设备列表 */
    if (p === "/devices" && req.method === "GET") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      return send(200, { ok: true, devices: listDevices(me.username) });
    }
    /* 用户中心：吊销设备（token 随之失效） */
    if (p === "/device/revoke" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const gone = revokeDevice(me.username, body && body.id);
      return gone ? send(200, { ok: true }) : send(404, { ok: false, error: "设备不存在" });
    }

    /* ── ⑤ 设备令牌通道：心跳（账号状态轮询用）+ 更新检查 ───────────────────── */
    /* 设备令牌版的列表/吊销：本机只有**设备令牌**（没有网页会话）⇒ 面板的「设备/座位」
       必须能用设备令牌查到同一个账号名下的设备（否则列表恒空 —— 10-14 实测现象）。 */
    if (p === "/device/list" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(403, { ok: false, error: "account-disabled" });
      const selfHash = Object.entries(db.devices).find(([, d]) => d === device)?.[0] || "";
      return send(200, {
        ok: true,
        account: device.username,
        devices: listDevices(device.username).map((d) => ({ ...d, current: d.id === deviceIdOf(selfHash) })),
      });
    }
    if (p === "/device/revoke-by-token" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const gone = revokeDevice(device.username, body && body.id);
      return gone ? send(200, { ok: true }) : send(404, { ok: false, error: "设备不存在" });
    }
    /* ── 统一身份：网页会话 或 设备令牌 ─────────────────────────────────────────
       ⛔ 桌面端「云端管理」面板没有登录会话，只有设备令牌 ⇒ 这两类只读/自助接口
       必须同时认设备令牌（否则面板里就是"啥都没有"）。管理员专属接口**不在此列**。 */
    function accountWho() {
      if (me) return { username: me.username, role: me.role, via: "session" };
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (device) {
        const u = db.users.find((x) => x.username === device.username);
        if (u && !u.disabled) return { username: device.username, role: u.role, via: "device" };
      }
      return null;
    }

    /* ── 闲时倍率：命中哪个时段 / 当前系数 ──────────────────────────────────────
       ⛔ 返回窗口对象（管理界面要显示"当前生效的是哪一段"），计费只用系数。 */
    function offPeakWindow(atMs = Date.now(), opts) {
      const cfg = db.offPeak;
      if (!cfg) return null;
      /* ⛔ 10-18 加 `ignoreEnabled`：计费要判"现在命中哪个时段"，**不能**被总闸挡住 ——
         总闸（enabled）现在只管"**没单独配**的模型要不要用全局默认系数"；
         模型自己配了系数的，一律按它算（用户令「每个模型单独的配置」）。
         否则会出现"给某模型配了折扣却静默不生效"——正是要修的那种坑。 */
      if (cfg.enabled !== true && !(opts && opts.ignoreEnabled === true)) return null;
      const windows = Array.isArray(cfg.windows) ? cfg.windows : [];
      const d = new Date(atMs);
      const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
      for (const w of windows) {
        const s = Number(w && w.start);
        const e = Number(w && w.end);
        /* ⛔⛔ `Number(null) === 0`（这个坑今天第三次）：直接把 w.rate 当数字，会把
           「该窗口没设默认倍率」变成 **0** ⇒ 该时段所有没单独设的模型全部免费白送。
           必须用 parseRate 解析 —— 空/缺/非法 ⇒ null（该窗口不设默认倍率）。 */
        const r = parseRate(w && w.rate);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (r !== null && !(r >= 0)) continue;
        if (s === e) continue;
        const hit = s < e ? (hour >= s && hour < e) : (hour >= s || hour < e);  // start>end = 跨零点
        if (hit) return { label: String(w.label || ""), start: s, end: e, rate: r };
      }
      return null;
    }
    /* ⛔ 原 `offPeakFactor()`（返回"折扣系数"）已删除：10-18 改为**替换语义**（闲时倍率直接定价），
       计费处不再乘任何系数 ⇒ 保留它只会让人以为还有"打折"这回事。 */
    /* 把"填进去的倍率"解析成数字。返回 null = **没配置**（沿用别的值），数字 = 就用它。
       ⛔ 与 `creditRate` 的区别：这里 null 表示"没配"，而 **0 是合法值**（该时段免费）——
         两者绝不能混（把"没配"当 0 就是白送，把 0 当"没配"就是用户配了免费却不生效）。
       复用点：每模型闲时倍率、窗口的默认闲时倍率。 */
    function parseRate(v) {
      if (v === undefined || v === null) return null;
      const raw = String(v).trim().replace(/^x/i, "");
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    /* 每模型单独配的**闲时倍率**（10-18 用户令「每个模型单独的配置」）。
       返回 null = 没单独配；数字 = 该模型在闲时时段直接按这个倍率计费。
       ⛔⛔ 语义是**替换**，不是折扣系数：正常 ×0.11、闲时填 0.05 ⇒ 闲时实际就是 0.05
          （不是 0.11 × 0.05 = 0.0055）。用户原话：「不是我填 0.5 就打 5 折」。 */
    function modelOffPeakRate(m) {
      return m ? parseRate(m.offPeakRate) : null;
    }
    /* 归一化管理员提交的时段表（信任边界校验；非法条目丢弃，不抛） */
    function normalizeOffPeakWindows(input) {
      const arr = Array.isArray(input) ? input : [];
      const out = [];
      arr.forEach((w, i) => {
        if (!w) return;
        const s = Math.trunc(Number(w.start));
        const e = Math.trunc(Number(w.end));
        if (!Number.isFinite(s) || !Number.isFinite(e)) return;
        if (s < 0 || s > 24 || e < 0 || e > 24) return;
        if (s === e) return;
        /* ⛔ 10-18：窗口的 `rate` 改为**可选**（该时段的默认闲时**倍率**）。留空 = 该时段不设默认，
           落到各模型自己的闲时倍率；模型也没配 ⇒ 沿用正常倍率（该时段不优惠）。
           ⛔⛔ 语义已从「折扣系数」改为「直接倍率」——存量 0.5 这类值必须清掉，
              否则会把正常 ×0.11 的模型按 ×0.5 计费（涨 4.5 倍）。 */
        const r = parseRate(w.rate);
        if (r !== null && r > 100) return;
        out.push({
          id: String(w.id || `w${i + 1}`).slice(0, 24),
          label: String(w.label || "").slice(0, 24),
          start: s, end: e,
          rate: r === null ? null : Math.round(r * 1000) / 1000,
        });
      });
      return out;
    }

    /* ── 模型目录同步（WBM → 本服务）────────────────────────────────────────────
       拉 WBM /api/model-catalog，归一化成客户端要的字段；credits（积分倍率）原样保留 ——
       ⛔ 倍率是"消耗速度随模型而定"的**唯一真相源**，本服务只转发不重写。 */
    async function pullModelCatalog(force = false) {
      const fresh = Date.now() - Number(db.modelCatalog.syncedAt || 0) < MODEL_SYNC_TTL_MS;
      if (!force && fresh && Array.isArray(db.modelCatalog.list) && db.modelCatalog.list.length) return { ok: true, cached: true };
      /* ⛔ 用 currentCatalogBase()（管理员可配），**不是** WBM_BASE 常量 ——
         否则"改了上游地址、点同步却还是拉旧地址"（配了没用，10-18 实测就是这个坑）。 */
      const catalogBase = currentCatalogBase();
      if (!catalogBase) return { ok: false, error: "wbm-not-configured" };
      try {
        /* ⛔ 10-18：目录来源**不止 WBM**。用户实测：上游是 OpenAI 兼容网关 ——
           `/api/model-catalog` 返 **401**、而 `/v1/models` 有 50 个模型 ⇒ 必须能回落。
           ⛔ 两源统一映射成同一份 list；OpenAI 源**没有倍率** ⇒ 打 `creditsMissing` 标记，
              由面板提示「未设倍率（当前免费）」。⛔ 绝不猜一个默认倍率 —— 猜错就是多扣钱。 */
        const authKey = WBM_TOKEN || currentGatewayKey();
        let data = null;
        let source = "wbm";
        const wbmRes = await fetch(`${catalogBase}/api/model-catalog?realm=cn`, { headers: authKey ? { Authorization: `Bearer ${authKey}` } : {} });
        if (wbmRes.ok) {
          data = await wbmRes.json();
        } else {
          const oaRes = await fetch(`${catalogBase}/v1/models`, { headers: authKey ? { Authorization: `Bearer ${authKey}` } : {} });
          if (!oaRes.ok) return { ok: false, error: `catalog-http-${wbmRes.status}/${oaRes.status}` };
          data = await oaRes.json();
          source = "openai";
        }
        const rows = source === "openai" ? (data.data || data.models || []) : (data.models || []);
        const list = rows.map((m) => {
          /* OpenAI 形状只有 id / object / created / owned_by：其余字段留空并标「缺倍率」 */
          if (source === "openai") {
            const oaId = String(m.id || "").trim();
            return {
              id: oaId, name: oaId,
              description: "OpenAI 兼容目录（上游未提供倍率与规格）",
              credits: "", tags: [], series: "",
              contextLength: null, maxOutputTokens: null,
              supportsImages: false, supportsReasoning: false,
              creditsMissing: true,
            };
          }
          return {
            id: String(m.id || "").trim(),
            name: String(m.name || m.id || "").trim(),
            description: String(m.description || "").slice(0, 200),
            credits: String(m.credits || "").trim(),
            tags: Array.isArray(m.tags) ? m.tags.slice(0, 6).map(String) : [],
            series: String(m.series || ""),
            contextLength: Number(m.context_length || 0) || null,
            maxOutputTokens: Number(m.max_output_tokens || 0) || null,
            supportsImages: Boolean(m.supports_images),
            supportsReasoning: Boolean(m.supports_reasoning),
          };
        }).filter((m) => m.id && !EXCLUDED_CATALOG_IDS.has(m.id));
        /* ⛔ 21:4x 用户令「把 auto 模型去了，那个不好判断用了哪个模型」：
           `auto` 由上游自动挑模型 ⇒ 记账时无法判断实际用了哪个 ⇒ 从目录里剔除
           （排除表见 EXCLUDED_CATALOG_IDS，方便以后再加）。
           ⛔ 同时修一个既有 bug：这里整体覆盖 modelCatalog ⇒ **available（开放目录）会被冲掉**，
              导致每次同步后"对用户开放的范围"失效。现在同步时保留 available，
              并把它与最新目录求交集（已下架的自动剔除）。
           ⛔⛔ 10-18 再修一个同类 bug（用户问「管理员改的模型倍率会不会生效」时查出）：
              原来的写法把 list 整个换成上游的新数组 ⇒ **管理员手改的 credits 被静默冲掉**，
              只有 ≤30 分钟的 TTL 窗口里有效，点一次「重新同步目录」立刻失效。
              现在按 id 做**倍率保全**：
                · 每个模型都记 `upstreamCredits`（上游原值快照，用于"恢复上游倍率"，不需联网）；
                · `creditsLocked === true` 的模型沿用上一份 `credits`（= 管理员改过的值）；
                · 没锁的模型继续跟上游走（上游调价自动生效）。
              ⇒ 语义：**管理员显式改过 = 钉住；没改过 = 跟随上游**。 */
        const prevAvail = Array.isArray(db.modelCatalog.available) ? db.modelCatalog.available : null;
        const prevList = Array.isArray(db.modelCatalog.list) ? db.modelCatalog.list : [];
        const prevById = new Map(prevList.filter((m) => m && m.id).map((m) => [m.id, m]));
        for (const m of list) {
          m.upstreamCredits = String(m.credits || "");
          const prev = prevById.get(m.id);
          if (prev && prev.creditsLocked === true) {
            m.credits = String(prev.credits === undefined || prev.credits === null ? "" : prev.credits);
            m.creditsLocked = true;
          }
          /* ⛔ 闲时系数是**本服务自己的配置**（上游目录里没有这个概念）⇒ 必须按 id 带过来。
             否则每 30 分钟一次目录同步就把它静默冲掉 —— 与倍率"回滚"完全同一个坑，已踩过一次。 */
          if (prev && prev.offPeakRate !== undefined && prev.offPeakRate !== null && String(prev.offPeakRate) !== "") {
            m.offPeakRate = prev.offPeakRate;
          }
        }
        const lockedIds = list.filter((m) => m.creditsLocked === true).map((m) => m.id);
        if (lockedIds.length) console.log(`[catalog] 保全管理员自定义倍率 ${lockedIds.length} 个：${lockedIds.slice(0, 8).join(", ")}${lockedIds.length > 8 ? "…" : ""}`);
        const ids = new Set(list.map((m) => m.id));
        db.modelCatalog = {
          syncedAt: Date.now(),
          realm: source === "openai" ? "openai" : String(data.realm || "cn"),
          /* ⛔ 记下目录来源：面板据此提示「上游没给倍率，需手动填」（openai 源一定缺倍率） */
          source: source === "openai" ? "openai-compat" : String(data.source_label || data.source || "wbm"),
          catalogSource: source,
          list,
          ...(prevAvail ? { available: prevAvail.filter((x) => ids.has(x)) } : {}),
        };
        persist();
        return { ok: true, count: list.length, syncedAt: db.modelCatalog.syncedAt };
      } catch (error) {
        /* ⛔ 出错信息可能含 URL/凭据（fetch 的 TypeError 会把地址带进来）⇒ 必须脱敏 */
        return { ok: false, error: "wbm-unreachable", message: sanitize(error && error.message) };
      }
    }

    /* ── 云端同步 API（设备令牌鉴权：本机上传；会话令牌：用户在网页查看/删除） ───────── */
    function syncAuth() {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (device) return { username: device.username, machineId: device.machineId || "", device };
      if (me) return { username: me.username, machineId: "", device: null };
      return null;
    }
    if (p === "/sync/usage" && req.method === "GET") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const used = syncUsageBytes(who.username);
      const index = readSyncIndex(who.username);
      const devices = listDevices(who.username).length;
      return send(200, {
        ok: true, usedBytes: used, limitBytes: storageLimitFor(who.username),
        sessions: Object.keys(index).length, devices, deviceLimit: DEVICE_LIMIT,
      });
    }
    if (p === "/sync/index" && req.method === "GET") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const index = readSyncIndex(who.username);
      const rows = Object.values(index)
        .map((r) => ({ id: r.id, title: r.title || "", project: r.project || "", machineName: r.machineName || "", machineId: r.machineId || "", lines: r.lines || 0, sizeBytes: r.sizeBytes || 0, uploadedAt: r.uploadedAt || 0, updatedAt: r.updatedAt || r.uploadedAt || 0 }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return send(200, { ok: true, sessions: rows, usedBytes: syncUsageBytes(who.username), limitBytes: storageLimitFor(who.username) });
    }
    /* 取单会话正文（设备令牌或网页会话都可）：本机"下载/恢复"与网页查看都用它。
       返回原始 jsonl 文本 + 元数据，客户端按行落回本地 sessions 目录（与本地同构）。 */
    if (p === "/sync/session" && req.method === "GET") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const id = String(url.searchParams.get("id") || "").trim();
      const index = readSyncIndex(who.username);
      const row = index[id];
      if (!row) return send(404, { ok: false, error: "not-found" });
      let content = "";
      try { content = fs.readFileSync(path.join(syncUserDir(who.username), "sessions", id + ".jsonl"), "utf8"); }
      catch { return send(404, { ok: false, error: "file-missing" }); }
      return send(200, { ok: true, id, meta: row, content });
    }
    if (p === "/sync/push" && req.method === "POST") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!who.device) return send(403, { ok: false, error: "device-token-required" });
      const body = await readBodyLarge();
      const incoming = Array.isArray(body && body.sessions) ? body.sessions : [];
      const index = readSyncIndex(who.username);
      let used = syncUsageBytes(who.username);
      const results = [];
      for (const item of incoming) {
        const id = String(item && item.id || "").trim();
        if (!id) continue;
        const lines = Array.isArray(item.lines) ? item.lines.map((l) => String(l)) : [];
        const from = Math.max(0, Number(item.fromOrdinal || 0));
        const dir = path.join(syncUserDir(who.username), "sessions");
        const file = path.join(dir, id + ".jsonl");
        const prev = index[id] || { lines: 0, sizeBytes: 0, uploadedAt: 0 };
        const prevBytes = Number(prev.sizeBytes || 0);
        const addBytes = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
        /* ⛔ 配额：超限就**不写这一条**并如实回报 —— 绝不留半截数据（客户端据此提示"已达上限"）。 */
        if (used + addBytes > storageLimitFor(who.username)) {
          results.push({ id, ok: false, error: "quota-exceeded", needBytes: addBytes, usedBytes: used, limitBytes: storageLimitFor(who.username) });
          continue;
        }
        try {
          fs.mkdirSync(dir, { recursive: true });
          if (lines.length) fs.appendFileSync(file, lines.join("\n") + "\n");
        } catch (error) {
          results.push({ id, ok: false, error: "write-failed", message: error.message });
          continue;
        }
        used += addBytes;
        index[id] = {
          id, lines: Number(prev.lines || 0) + lines.length, sizeBytes: prevBytes + addBytes,
          title: String(item.title || prev.title || "").slice(0, 200),
          project: String(item.project || prev.project || "").slice(0, 200),
          machineId: who.machineId || prev.machineId || "",
          machineName: String(who.device && who.device.name || prev.machineName || "").slice(0, 64),
          uploadedAt: prev.uploadedAt || Date.now(), updatedAt: Date.now(),
        };
        results.push({ id, ok: true, lines: index[id].lines, sizeBytes: index[id].sizeBytes });
      }
      writeSyncIndex(who.username, index);
      return send(200, { ok: true, results, usedBytes: used, limitBytes: storageLimitFor(who.username) });
    }
    if (p === "/sync/delete" && req.method === "POST") {
      const who = syncAuth();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const index = readSyncIndex(who.username);
      const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
      const project = String(body && body.project || "");
      const targets = Object.keys(index).filter((id) => (ids.includes(id)) || (project && index[id] && index[id].project === project));
      for (const id of targets) {
        try { fs.rmSync(path.join(syncUserDir(who.username), "sessions", id + ".jsonl"), { force: true }); } catch { /* 忽略 */ }
        delete index[id];
      }
      writeSyncIndex(who.username, index);
      return send(200, { ok: true, deleted: targets.length, usedBytes: syncUsageBytes(who.username), limitBytes: storageLimitFor(who.username) });
    }
    /* ── 内置供应商「限时福利」：模型列表（含每模型积分倍率）+ 生效勾选 ───────── */
    if (p === "/models" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const pulled = await pullModelCatalog(false);
      const enabled = new Set(Array.isArray(db.userModels[who.username]) ? db.userModels[who.username] : []);
      /* ⛔ 20:4x 用户令「不是让用户那边全部勾选，只是他那边可用模型刷新」：
         `modelCatalog.available` = 管理员在「用户可用模型」里勾选的那批 = **对用户开放的目录**；
         这里只把开放目录里的模型列出来（用户端能看到、能自行勾选），
         `enabled` 仍取**该用户自己的** userModels（不替用户勾）。未设置 available 时兼容为全部。 */
      const avail = Array.isArray(db.modelCatalog.available) && db.modelCatalog.available.length
        ? new Set(db.modelCatalog.available) : null;
      const models = (db.modelCatalog.list || [])
        .filter((m) => !avail || avail.has(m.id))
        .map((m) => ({ ...m, enabled: enabled.has(m.id) }));
      return send(200, {
        ok: true,
        provider: {
          id: BUILTIN_PROVIDER_ID,
          name: BUILTIN_PROVIDER_NAME,
          /* ⛔ 只给**同源代理路径**：客户端永不接触上游真实地址与网关密钥。
             真实地址与 wbk_ 密钥只存在本服务（凭据目录）并由代理在服务端注入。 */
          baseUrl: BUILTIN_PROXY_PATH,
          ready: Boolean(currentUpstreamBase() && currentGatewayKey()),
          /* 客户端据此决定是否要调 /proxy/token 签发（明文只在那一次响应里） */
          hasProxyToken: Boolean(db.proxyTokens[who.username]),
        },
        models,
        enabledCount: enabled.size,
        total: models.length,
        syncedAt: db.modelCatalog.syncedAt,
        realm: db.modelCatalog.realm,
        source: db.modelCatalog.source,
        sync: pulled.ok ? "ok" : pulled.error,
        /* 闲时倍率快照（客户端据此显示「当前闲时 ×0.5」并预热预期消耗）。
           ⛔ 带 `tzOffsetMinutes`：时段判定用的是**服务器本地时间**，客户端要靠这个偏移
              把自己那边的 "现在" 换算成服务器的小时数，否则跨时区/边界处会算错一格。 */
        offPeak: {
          enabled: db.offPeak.enabled === true,
          windows: Array.isArray(db.offPeak.windows) ? db.offPeak.windows : [],
          active: offPeakWindow(),
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        },
      });
    }
    /* 勾选生效模型：整集覆盖（前端去抖后提交全量），只接受目录里存在的 id */
    if (p === "/models/enabled" && req.method === "POST") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const known = new Set((db.modelCatalog.list || []).map((m) => m.id));
      const avail = Array.isArray(db.modelCatalog.available) && db.modelCatalog.available.length
        ? new Set(db.modelCatalog.available) : null;
      const ids = Array.isArray(body && body.ids)
        ? body.ids.map(String).filter((id) => known.has(id) && (!avail || avail.has(id)))
        : [];
      db.userModels[who.username] = Array.from(new Set(ids));
      persist();
      return send(200, { ok: true, enabledCount: db.userModels[who.username].length, enabled: db.userModels[who.username] });
    }
    /* 签发 / 轮换本用户的代理令牌（明文**仅此一次**返回，之后无法再取）。
       ⛔ 10-14：鉴权从「只认网页会话」改为 accountWho()（会话 或 设备令牌）——
       桌面端「云端管理」面板只有设备令牌，否则签不出令牌 ⇒ 限时福利供应商没有 key
       ⇒ 模型勾了也调不通（用户实测「我选了模型生效，下拉框里面没有啊」的连环根因之一）。 */
    if (p === "/proxy/token" && req.method === "POST") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const token = PROXY_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
      /* ⛔ 轮换时把旧把**压进环**而不是丢掉：外部消费者存的是快照，直接作废就会 401。 */
      const prevHashes = pushRing(db.proxyTokens[who.username], PROXY_TOKEN_RING);
      db.proxyTokens[who.username] = { hash: hashProxyToken(token), prefix: token.slice(0, 12), createdAt: Date.now(), lastUsedAt: 0, ips: [], prevHashes };
      persist();
      console.log(`[proxy] 已为账号 ${who.username} 签发代理令牌 ${token.slice(0, 12)}…[已脱敏] via=${who.via}（环内旧令牌 ${prevHashes.length}/${PROXY_TOKEN_RING - 1} 仍有效）`);
      return send(200, { ok: true, token, prefix: token.slice(0, 12), note: "明文仅此一次，请客户端立即保存到本机配置" });
    }
    /* 代理转发的目标：OpenAI 兼容的对话接口（流式原样透传）。
       ⛔ 上游真实地址与网关密钥**只在这里**出现，绝不回传客户端；
       ⛔ 未配置网关密钥时如实 503，不静默降级。 */
    /* ⛔ 20:3x：/models 与 /chat/completions 的前缀规则不同 ——
       引擎的对话请求自带 /v1（POST /v1/chat/completions），但设置页「连接测试」请求的是
       **不带 v1** 的 /models ⇒ 404（用户实测「测试也不通：HTTP 404 not-found」）。
       这里同时接受 /proxy/models 与 /proxy/v1/models，两种请求方式都算通。 */
    /* ⛔ 20:5x 用户实测「用不了，给我定位出来」——引擎日志给出真凶：
       `url: http://127.0.0.1:47121/p/limited-benefit/responses` ⇒ 桥识别为 Responses 后
       按 `rest.replace(/\/responses$/, "/chat/completions")` 改写 ⇒ 实际发出的是
       `https://…/cloud-api/proxy/**chat/completions**`（**不带 /v1**），
       而服务端只注册了 /proxy/v1/chat/completions ⇒ 404「not-found」⇒ 5 次重连全废。
       ⇒ 这里同时接受带 /v1 与不带 /v1 两种形态（与 models 的处理保持一致）。 */
    if ((p === "/proxy/v1/chat/completions" || p === "/proxy/chat/completions") && req.method === "POST" ||
        ((p === "/proxy/v1/models" || p === "/proxy/models") && req.method === "GET")) {
      const header = String(req.headers.authorization || "");
      const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!presented || !presented.startsWith(PROXY_TOKEN_PREFIX)) {
        return send(401, { ok: false, error: "proxy-token-required" });
      }
      const hit = proxyUserByToken(presented);
      if (!hit) return send(401, { ok: false, error: "invalid-proxy-token" });
      const owner = db.users.find((u) => u.username === hit.username);
      if (!owner || owner.disabled) return send(403, { ok: false, error: "account-disabled" });
      /* 来源绑定：首次见到就记住，最多 PROXY_IP_LIMIT 个；超出直接拒（防令牌被转发给别人用） */
      const ip = ipOf(req);
      const ips = Array.isArray(hit.row.ips) ? hit.row.ips : [];
      if (!ips.includes(ip)) {
        if (ips.length >= PROXY_IP_LIMIT) return send(403, { ok: false, error: "proxy-ip-limit", message: "该令牌已在其它网络使用过，如需更换请重新签发" });
        ips.push(ip); hit.row.ips = ips;
      }
      hit.row.lastUsedAt = Date.now();
      /* 走旧令牌 = 某个外部副本还没跟上轮换；记下来，运维看日志就知道该更新谁了。 */
      if (hit.viaRing) console.log(`[proxy] 账号 ${hit.username} 用**环内旧令牌**通过鉴权（外部副本待更新）`);
      persist();
      if (!currentUpstreamBase() || !currentGatewayKey()) return send(503, { ok: false, error: "upstream-not-configured" });
      /* ⛔ 先把请求体读完（判模型与转发都要用）。
         10-14 踩坑：原先把这段放在下面 ⇒ 上面的判模型引用了尚未声明的 bodyBuf，
         抛错被 catch 吞掉 ⇒ 未勾选的模型**照样放行**。顺序必须是这样。 */
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyBuf = Buffer.concat(chunks);
      /* ⛔ 勾选即生效：只放行用户勾选的模型（未勾选 ⇒ 403，附明确文案）。
         这是"勾选管理哪些模型生效"的执行点 —— 界面只是表达，这里是强制。 */
      const allowed = new Set(Array.isArray(db.userModels[hit.username]) ? db.userModels[hit.username] : []);
      if (p.endsWith("models")) {
        // 模型清单也按勾选过滤（客户端因此只看得到自己启用的）
        const upstreamList = await (async () => {
          try {
            const r = await fetch(`${currentUpstreamBase()}/v1/models`, { headers: { Authorization: `Bearer ${currentGatewayKey()}` } });
            return r.ok ? await r.json() : null;
          } catch { return null; }
        })();
        if (!upstreamList) return send(502, { ok: false, error: "upstream-unreachable" });
        /* ⛔ 20:5x 用户令「怎么不是云端管理里面勾选那个显示那个啊，全出来了」：
           清单口径 = **管理员设定的开放目录**（modelCatalog.available），而不是用户的勾选。
           用户端要看到"开放的全部模型"才能**自行勾选**（旧实现只回已勾的 ⇒ 用户永远看不到新模型）。
           未设置 available 时兼容为全部。`enabled` 语义仍由客户端按各自的 userModels 标注。 */
        const avail = Array.isArray(db.modelCatalog.available) && db.modelCatalog.available.length
          ? new Set(db.modelCatalog.available) : null;
        const data = Array.isArray(upstreamList.data)
          ? upstreamList.data.filter((m) => !avail || avail.has(String(m.id || "")))
          : [];
        return send(200, { ...upstreamList, data });
      }
      /* 余额预检：≤0 直接拒（不让上游白跑；管理员发放后即可继续） */
      const myBalance = pointsOf(hit.username).balance;
      if (myBalance <= 0) {
        return send(402, { ok: false, error: "insufficient-points", balance: myBalance, message: "积分为 0，已暂停调用 —— 请联系管理员加分或改用其它供应商" });
      }
      let wantedModel = "";
      try { wantedModel = String((JSON.parse(bodyBuf.toString("utf8")) || {}).model || ""); } catch { /* 解析不了就交给上游报错 */ }
      if (wantedModel && !allowed.has(wantedModel)) {
        return send(403, { ok: false, error: "model-not-enabled", message: "该模型未在「限时福利」里启用 —— 请在云端管理的模型列表里勾选后重试" });
      }
      /* 转发：只替换 Authorization，其余原样（模型、参数、流式标志） */
      const target = `${currentUpstreamBase()}/v1/${p.endsWith("models") ? "models" : "chat/completions"}`;
      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers: { Authorization: `Bearer ${currentGatewayKey()}`, "Content-Type": String(req.headers["content-type"] || "application/json") },
          body: req.method === "POST" ? bodyBuf : undefined,
        });
        res.writeHead(upstream.status, { "Content-Type": String(upstream.headers.get("content-type") || "application/json"), "Cache-Control": "no-store" });
        /* 透传的同时**采集**响应（最多留 256KB 用于解析用量），不改动发回客户端的字节 */
        const seen = [];
        let seenBytes = 0;
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            res.write(chunk);
            if (seenBytes < 256 * 1024) { seen.push(chunk); seenBytes += chunk.length; }
          }
        }
        res.end();
        /* ⛔ 记分口径：直接用 **WBM 返回的 usage.credit**（上游自己算的）⇒ 与 WBM 天然同步；
           取不到就如实不记（宁可少记也不瞎记），由对账环节兜底。 */
        try {
          const text = Buffer.concat(seen).toString("utf8");
          let credit = null;
          const m1 = /"credit"\s*:\s*(-?[0-9.]+)/.exec(text);
          if (m1) credit = Number(m1[1]);
          if (credit === null) {
            const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
            for (let i = lines.length - 1; i >= 0 && credit === null; i--) {
              try {
                const j = JSON.parse(lines[i].slice(5).trim());
                const u = j && j.usage;
                if (u && (u.credit !== undefined || u.total_credit !== undefined)) credit = Number(u.credit !== undefined ? u.credit : u.total_credit);
              } catch { /* 忽略非 JSON 行 */ }
            }
          }
          /* ⛔⛔ 21:5x 用户定案：「以后就按用户管理里面的倍率扣积分，**不用管上游了**」。
             ⇒ 计价口径**唯一**取自服务端目录（管理界面可改的 `credits` 倍率），
                上游返回的 `usage.credit` **不再参与**（实测它对收费模型也常返 0）。
             公式：**积分 = (prompt_tokens + completion_tokens) / 1000 × 倍率**，保留 2 位小数。
             例：deepseek-v4.1-flash（×0.11）跑 1000 tokens ⇒ 0.11 分；95 tokens ⇒ 0.01 分。
             ⛔ 真·免费模型（倍率 ×0.00 或目录未配倍率）⇒ 结果为 0 ⇒ 只留痕不扣分
                （10-14 用户令「免费的模型，只要调用了，就要有记录」）。
             ⛔ "拿不到 token 数"时才回落到上游 credit，再拿不到就不记（宁可少记不瞎记）。 */
          try {
            /* ⛔ 模型名归一化后再查目录：客户端可能带 `cn:` / `global:` 前缀或大小写差异，
               原先 `m.id === wantedModel` 的**严格相等**会把这类请求判成"目录里没有" ⇒ rate=0
               ⇒ 整个调用按免费记账（倍率改了也白改）。现在：去前缀+转小写 → 先精确、后最长子串。 */
            const wantedNorm = String(wantedModel || "").trim().toLowerCase().replace(/^(cn|global)\s*:\s*/, "");
            const catList = db.modelCatalog.list || [];
            let item = catList.find((m) => String(m.id || "").trim().toLowerCase() === wantedNorm);
            if (!item && wantedNorm) {
              const keys = catList
                .filter((m) => m && m.id)
                .sort((a, b) => String(b.id).length - String(a.id).length);   // 最长优先（flashx 别被 flash 抢走）
              item = keys.find((m) => wantedNorm.includes(String(m.id).trim().toLowerCase()));
            }
            const rawCredits = item && item.credits ? String(item.credits).replace(/^x/i, "") : "";
            const normalRate = rawCredits === "" ? 0 : Number(rawCredits);
            const pTok = /"prompt_tokens"\s*:\s*(\d+)/.exec(text);
            const cTok = /"completion_tokens"\s*:\s*(\d+)/.exec(text);
            const totalTokens = (pTok ? Number(pTok[1]) : 0) + (cTok ? Number(cTok[1]) : 0);
            /* 闲时（10-18：**每模型单独配置 + 替换语义**）。
               ⛔⛔ 闲时倍率是**直接定价**，不是折扣系数 —— 命中时段就用它**替换**正常倍率，
                  绝不乘上去：用户原话「不是我填 0.5 就打 5 折，前面 0.11 后面闲时我可以填 0.05」。
                  （按相乘算 0.11 × 0.05 = 0.0055，会直接把该模型打成近免费。）
               优先级：① 模型自己配了 ⇒ 一律按它（**不看总闸** —— 配了就该生效）；
                       ② 没配 ⇒ 总闸开着且该窗口配了默认闲时倍率 ⇒ 用它；
                       ③ 都没有 ⇒ 沿用正常倍率（= 该时段不优惠，不是"打 1 折"）。
               ⛔ 时段命中判定用 ignoreEnabled，否则总闸关着时连每模型配置都探不到。 */
            const hit = offPeakWindow(Date.now(), { ignoreEnabled: true });
            const ownRate = modelOffPeakRate(item);
            const winRate = hit ? parseRate(hit.rate) : null;
            let offRate = null;
            if (hit) {
              if (ownRate !== null) offRate = ownRate;
              else if (db.offPeak.enabled === true && winRate !== null) offRate = winRate;
            }
            const rate = offRate !== null ? offRate : normalRate;
            const peak = offRate !== null ? hit : null;
            if (totalTokens > 0 && Number.isFinite(rate) && rate > 0) {
              const computed = Math.round((totalTokens / 1000) * rate * 100) / 100;
              const offNote = peak
                ? `（闲时${peak.label ? `「${peak.label}」` : ""}${peak.start}–${peak.end}点，按闲时倍率 ${rate}${ownRate !== null ? "，该模型单独配置" : ""}）`
                : "";
              console.log(`[points] 计价：${wantedModel} ${totalTokens} tokens × ${rate} = ${computed}${offNote}（口径=服务端倍率）`);
              credit = computed;   // ⛔ 一律以本服务端的倍率为准（忽略上游 credit）
            } else if (!(credit > 0)) {
              credit = 0;
            }
          } catch { /* 计价失败则维持原判 */ }
          if (credit !== null && Number.isFinite(credit) && credit >= 0) {
            const ref = `call:${crypto.randomBytes(8).toString("hex")}`;
            const label = wantedModel || "模型调用";
            const r = credit > 0
              ? addPoints(hit.username, -credit, "consume", ref, `限时福利 · ${label} 消耗 ${credit}`)
              : addUsageOnly(hit.username, "consume", ref, `限时福利 · ${label}（免费模型，未扣积分）`);
            /* ⛔ 10-18 修：`addPoints` / `addUsageOnly` **只改内存不落盘**（它们的实现里没有 persist），
               原来这里也没有 ⇒ 这条消耗流水要等**下一次**请求在鉴权处顺带 persist 才写进 data.json；
               若期间服务重启/崩溃，这次消耗就**永久丢失**（用户只调一次就重启 ⇒ 白送）。
               消耗是账本，必须当场落盘。 */
            if (r.changed) { persist(); console.log(`[points] ${hit.username} ${credit > 0 ? `消耗 ${credit}` : "免费调用"}（余额 ${r.balance}）`); }
          }
        } catch { /* 记分失败不影响调用本身 */ }
      } catch (error) {
        send(502, { ok: false, error: "upstream-unreachable", message: sanitize(error && error.message) });
      }
      return;
    }
    /* 管理员：立刻重新拉取模型目录（force 绕过缓存） */
    if (p === "/admin/models/sync" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const pulled = await pullModelCatalog(true);
      return send(pulled.ok ? 200 : 502, { ok: pulled.ok, ...pulled, total: (db.modelCatalog.list || []).length });
    }
    /* ── 10-15 管理员模型管理：目录 + 每用户可用模型 + 倍率 ─────────────── */
    if (p === "/admin/models" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const users = db.users.map((u) => ({
        username: u.username,
        role: u.role,
        ids: Array.isArray(db.userModels[u.username]) ? db.userModels[u.username] : [],
      }));
      return send(200, {
        ok: true,
        list: (db.modelCatalog.list || []),
        available: Array.isArray(db.modelCatalog.available) ? db.modelCatalog.available : null,
        syncedAt: db.modelCatalog.syncedAt || 0,
        source: db.modelCatalog.source || "",
        users,
      });
    }
    /* 管理员设置「对用户开放」的模型集合（= 用户端可见、可自行勾选的范围）。
       ⛔ 与 /admin/users/models 的区别：那个是写每个用户自己的勾选（替他选）；
       这个是定目录边界（他能选什么）。 */
    if (p === "/admin/models/available" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const ids = Array.isArray(body && body.ids) ? body.ids.map((x) => String(x)) : [];
      const known = new Set((db.modelCatalog.list || []).map((m) => m.id));
      const bad = ids.filter((x) => !known.has(x));
      if (bad.length) return send(400, { ok: false, error: "含未知模型：" + bad.slice(0, 3).join(", ") });
      db.modelCatalog.available = Array.from(new Set(ids));
      persist();
      console.log(`[admin] ${me.username} 设置对用户开放的模型 ${db.modelCatalog.available.length} 个`);
      return send(200, { ok: true, ids: db.modelCatalog.available });
    }

    /* 改某个模型的积分倍率：credits 形如 "x0.29"，空串 = 免费 */
    if (p === "/admin/models/credits" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const id = String(body && body.id || "").trim();
      const item = (db.modelCatalog.list || []).find((m) => m.id === id);
      if (!item) return send(404, { ok: false, error: "模型不存在（先同步目录）" });
      /* 恢复上游倍率：不需要联网，用同步时留的 upstreamCredits 快照，并解锁 */
      if (body && body.reset === true) {
        item.credits = String(item.upstreamCredits || "");
        delete item.creditsLocked;
        persist();
        console.log(`[admin] ${me.username} 将模型 ${id} 恢复为上游倍率 ${item.credits || "（空=免费）"}`);
        return send(200, { ok: true, id, credits: item.credits, locked: false, reset: true });
      }
      const raw = String(body && body.credits === undefined ? "" : body.credits).trim();
      /* 归一化：允许 "0.29" / "x0.29" / 数字 / 空串；空串=免费 */
      let credits = "";
      if (raw && raw !== "0") {
        const n = Number(raw.replace(/^x/i, ""));
        if (!Number.isFinite(n) || n < 0) return send(400, { ok: false, error: "倍率必须是数字（如 0.29）或留空表示免费" });
        credits = "x" + String(n);
      }
      /* 闲时系数（**每模型**，10-18 用户令「每个模型单独的配置」）—— 可选字段：
         · undefined = 这次不动它（只改倍率的旧前端照样能用）；
         · 空串 / null = 清除（该模型跟随全局默认系数）；
         · 数字 = 该模型自己的闲时折扣系数（乘在模型倍率之上，1 = 不打折，0 = 该时段免费）。
         ⛔ 必须先校验再落字段：中途 return 400 不能留下「倍率已改、系数没改」的半截状态。 */
      let opRate;
      if (body && body.offPeakRate !== undefined) {
        const rawOp = body.offPeakRate === null ? "" : String(body.offPeakRate).trim();
        if (rawOp === "") {
          opRate = null;
        } else {
          const n = Number(rawOp.replace(/^x/i, ""));
          if (!Number.isFinite(n) || n < 0) return send(400, { ok: false, error: "闲时系数必须是数字（如 0.5）或留空表示跟随全局" });
          opRate = n;
        }
      }
      item.credits = credits;
      /* ⛔ 打了 "钉" 标记 ⇒ 之后每次目录同步都保留这个值（否则会被上游值静默冲掉） */
      item.creditsLocked = true;
      if (opRate === null) delete item.offPeakRate;
      else if (opRate !== undefined) item.offPeakRate = opRate;
      persist();
      console.log(`[admin] ${me.username} 将模型 ${id} 的倍率设为 ${credits || "免费"}${opRate === null ? "、闲时系数=跟随全局" : opRate !== undefined ? `、闲时系数=${opRate}` : ""}（已钉住，同步不覆盖）`);
      return send(200, { ok: true, id, credits, locked: true, offPeakRate: item.offPeakRate === undefined ? null : item.offPeakRate });
    }
    /* ── 10-18 闲时（限时）倍率：管理员可改 ──────────────────────────────
       语义：**折扣系数，乘在模型倍率之上**。读取用于界面回显 + 显示当前命中窗口。 */
    if (p === "/admin/offpeak" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      return send(200, {
        ok: true,
        enabled: db.offPeak.enabled === true,
        windows: Array.isArray(db.offPeak.windows) ? db.offPeak.windows : [],
        active: offPeakWindow(),
        serverHour: new Date().getHours(),
        serverTime: new Date().toISOString(),
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      });
    }
    if (p === "/admin/offpeak" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      if (body && Array.isArray(body.windows)) {
        const windows = normalizeOffPeakWindows(body.windows);
        if (body.windows.length && !windows.length) return send(400, { ok: false, error: "时段不合法：起止需为 0–24 且不相等，系数 0–100" });
        db.offPeak.windows = windows;
      }
      if (body && body.enabled !== undefined) db.offPeak.enabled = body.enabled === true || body.enabled === "true" || body.enabled === 1;
      persist();
      const active = offPeakWindow();
      console.log(`[admin] ${me.username} 闲时 ${db.offPeak.enabled ? "开启" : "关闭"}，时段 ${db.offPeak.windows.map((w) => `${w.label || "时段"}${w.start}-${w.end}点${w.rate === null || w.rate === undefined ? "（未设默认倍率）" : `默认×${w.rate}`}`).join("、") || "（空）"}，当前${active ? `命中「${active.label}」` : "未命中"}`);
      return send(200, { ok: true, enabled: db.offPeak.enabled === true, windows: db.offPeak.windows, active, serverHour: new Date().getHours(), tzOffsetMinutes: new Date().getTimezoneOffset() });
    }
    /* 设置某个用户可用的模型（整集覆盖，与用户端"勾选即生效"同一份数据） */
    if (p === "/admin/users/models" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const ids = Array.isArray(body && body.ids) ? body.ids.map((x) => String(x)) : [];
      const known = new Set((db.modelCatalog.list || []).map((m) => m.id));
      const bad = ids.filter((x) => !known.has(x));
      if (bad.length) return send(400, { ok: false, error: "含未知模型：" + bad.slice(0, 3).join(", ") });
      /* ⛔ 20:4x 用户令「不用每个用户单独设置，太慢了」：支持批量 ——
         · users: ["a","b"] 指定若干用户； · all: true 应用到**全部**用户（一键铺开）。
         username（单个）仍兼容，供单选界面使用。 */
      let targets = [];
      if (body && body.all === true) targets = db.users.map((u) => u.username);
      else if (Array.isArray(body && body.users)) targets = body.users.map((x) => String(x));
      else targets = [String(body && body.username || "").trim()];
      targets = Array.from(new Set(targets.filter(Boolean)));
      const missing = targets.filter((x) => !db.users.some((u) => u.username === x));
      if (missing.length) return send(404, { ok: false, error: "用户不存在：" + missing.join(", ") });
      if (!targets.length) return send(400, { ok: false, error: "没有指定用户" });
      targets.forEach((u) => { db.userModels[u] = ids.slice(); });
      persist();
      console.log(`[admin] ${me.username} 将 ${ids.length} 个模型同步到 ${targets.length} 个用户：${targets.join(", ")}`);
      return send(200, { ok: true, count: targets.length, usernames: targets, ids });
    }

    /* ── 积分：自己的余额与流水 / 管理端总览与发放 ─────────────────────────── */
    /* ── 知识库轻页接口（10-16 用户令：原界面不给普通用户看）─────────────────────
       全部带账号会话；服务端用管理员 Key + **该用户自己的 kbId** 代调 ⇒ 天然按用户隔离，
       浏览器永远拿不到 WeKnora 的界面与管理员凭据。未授权一律 403 not-activated（锁在服务端）。 */
    if (p === "/kb/docs" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!featureState(who.username, "knowledge").enabled) return send(403, { ok: false, error: "not-activated" });
      const info = await ensureKnowledgeFor(who.username);
      const list = await weknoraAdmin(`/api/v1/knowledge-bases/${info.kbId}/knowledge`);
      const rows = (list && list.data) || [];
      const st = featureState(who.username, "knowledge");
      return send(200, {
        ok: true, kbName: info.kbName, quotaMb: st.quotaMb, usedMb: st.usedMb,
        docs: rows.map((r) => ({ id: r.id, title: r.title || r.file_name || "(未命名)", status: r.parse_status || "", size: Number(r.file_size || 0), at: r.created_at || 0, note: r.error_message || "" })),
      });
    }

    /* 取原文件字节（图片预览/下载用）：同样**先校验归属**，服务端带管理员 Key 去取，
       浏览器永远拿不到管理员凭据。 */
    if (p === "/kb/file" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!featureState(who.username, "knowledge").enabled) return send(403, { ok: false, error: "not-activated" });
      const id = String(url.searchParams.get("id") || "").trim();
      if (!id) return send(400, { ok: false, error: "缺少文档 id" });
      const info = await ensureKnowledgeFor(who.username);
      const list = await weknoraAdmin(`/api/v1/knowledge-bases/${info.kbId}/knowledge`);
      const mine = ((list && list.data) || []).find((k) => k.id === id);
      if (!mine) return send(403, { ok: false, error: "not-your-doc" });
      const up = await fetch(`${WEKNORA_BASE}/api/v1/knowledge/${encodeURIComponent(id)}/download`, { headers: { "X-API-Key": WEKNORA_ADMIN_KEY } });
      if (!up.ok) return send(502, { ok: false, error: `取文件失败：${up.status}` });
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": up.headers.get("content-type") || "application/octet-stream",
        "Content-Length": buf.length,
        "Cache-Control": "private, max-age=300",
      });
      return res.end(buf);
    }

    /* 文档预览：返回该文档的分块正文（与检索命中同一份内容）。
       ⛔ 必须**先校验这份文档属于调用者自己的库**——管理员 Key 是租户级的，
         不校验就等于"知道 id 就能读别人库里的文档"（越权）。 */
    if (p === "/kb/doc" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!featureState(who.username, "knowledge").enabled) return send(403, { ok: false, error: "not-activated" });
      const id = String(url.searchParams.get("id") || "").trim();
      if (!id) return send(400, { ok: false, error: "缺少文档 id" });
      const info = await ensureKnowledgeFor(who.username);
      const list = await weknoraAdmin(`/api/v1/knowledge-bases/${info.kbId}/knowledge`);
      const mine = ((list && list.data) || []).find((k) => k.id === id);
      if (!mine) return send(403, { ok: false, error: "not-your-doc" });
      const data = await weknoraAdmin(`/api/v1/chunks/${encodeURIComponent(id)}`);
      const rows = (data && data.data) || [];
      return send(200, {
        ok: true,
        title: mine.title || mine.file_name || "(未命名)",
        status: mine.parse_status || "",
        chunks: rows
          .map((c) => ({ seq: Number(c.seq_id || 0), text: String(c.content || "") }))
          .sort((a, b) => a.seq - b.seq)
          .slice(0, 200),
      });
    }

    if (p === "/kb/search" && req.method === "POST") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!featureState(who.username, "knowledge").enabled) return send(403, { ok: false, error: "not-activated" });
      const body = await readBody();
      const query = String((body && body.query) || "").trim().slice(0, 500);
      if (!query) return send(400, { ok: false, error: "缺少检索词" });
      if (!rateLimit(`kbsearch:${who.username}`, 30, 60_000)) return send(429, { ok: false, error: "检索太频繁，请稍后再试" });
      const info = await ensureKnowledgeFor(who.username);
      const found = await weknoraAdmin("/api/v1/knowledge-search", { method: "POST", body: { query, knowledge_base_ids: [info.kbId] } });
      const hits = (found && (found.data || found.results)) || [];
      return send(200, {
        ok: true,
        hits: hits.slice(0, 8).map((h) => ({
          title: h.knowledge_title || h.knowledge_filename || "",
          snippet: String(h.matched_content || h.content || "").replace(/\s+/g, " ").slice(0, 400),
          score: Number(h.score || 0),
        })),
      });
    }

    /* 上传：浏览器把文件读成 base64 放进 JSON（服务端不写 multipart 解析），
       这里解码后**以 multipart 转发**给 WeKnora。 */
    if (p === "/kb/upload" && req.method === "POST") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const st = featureState(who.username, "knowledge");
      if (!st.enabled) return send(403, { ok: false, error: "not-activated" });
      if (!rateLimit(`kbupload:${who.username}`, 10, 60_000)) return send(429, { ok: false, error: "上传太频繁，请稍后再试" });
      const body = await readBodyLarge(24 * 1024 * 1024);
      const name = String((body && body.name) || "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120) || "upload.txt";
      const b64 = String((body && body.contentB64) || "");
      if (!b64) return send(400, { ok: false, error: "缺少文件内容" });
      /* 图片：配了视觉模型（VLM）就放行，没配才拦（并说人话）。 */
      const ext = String(name.split(".").pop() || "").toLowerCase();
      const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "svg"];
      if (IMAGE_EXT.indexOf(ext) >= 0 && !WEKNORA_VLM_MODEL_ID) {
        return send(400, { ok: false, error: "image-not-supported", reason: "图片解析需要额外开启「视觉模型」，当前未开启。请上传 PDF / Word / Excel / Markdown / txt 等文本类资料；确需图片解析请联系管理员。" });
      }
      let buf = null;
      try { buf = Buffer.from(b64, "base64"); } catch { return send(400, { ok: false, error: "文件内容不是合法 base64" }); }
      if (!buf || !buf.length) return send(400, { ok: false, error: "文件是空的" });
      const mb = buf.length / 1048576;
      if (st.quotaMb > 0 && st.usedMb + mb > st.quotaMb) {
        return send(402, { ok: false, error: "quota-exceeded", quotaMb: st.quotaMb, usedMb: st.usedMb });
      }
      const info = await ensureKnowledgeFor(who.username);
      const form = new FormData();
      form.append("file", new Blob([buf]), name);
      const res = await fetch(`${WEKNORA_BASE}/api/v1/knowledge-bases/${info.kbId}/knowledge/file`, { method: "POST", headers: { "X-API-Key": WEKNORA_ADMIN_KEY }, body: form });
      const text = await res.text();
      if (!res.ok) {
        /* 上游的人话版错误：把 VLM/多模态这类"需要额外配置"的情形翻译成用户能懂的一句话。 */
        const hint = /VLM|多模态|multimodal/i.test(text)
          ? "该文件需要视觉模型解析（当前未开启），请改传 PDF / Word / Excel / Markdown / txt"
          : "";
        return send(502, { ok: false, error: hint || sanitize(`上游拒绝：${res.status} ${text.slice(0, 160)}`) });
      }
      /* 记额度（近似：按本次上传字节累计，删除不回退 —— 与"额度"语义一致） */
      const slot = entitlementsOf(who.username).knowledge;
      slot.usedMb = Math.round((Number(slot.usedMb || 0) + mb) * 10) / 10;
      persist();
      return send(200, { ok: true, name, size: buf.length, usedMb: slot.usedMb, quotaMb: st.quotaMb });
    }

    if (p === "/kb/delete" && req.method === "POST") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      if (!featureState(who.username, "knowledge").enabled) return send(403, { ok: false, error: "not-activated" });
      const body = await readBody();
      const id = String((body && body.id) || "").trim();
      if (!id) return send(400, { ok: false, error: "缺少文档 id" });
      const info = await ensureKnowledgeFor(who.username);
      /* ⛔ 归属校验：管理员 Key 是租户级的，不校验就能删别人的文档（越权）。 */
      const list = await weknoraAdmin(`/api/v1/knowledge-bases/${info.kbId}/knowledge`);
      if (!((list && list.data) || []).some((k) => k.id === id)) return send(403, { ok: false, error: "not-your-doc" });
      await weknoraAdmin(`/api/v1/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" });
      return send(200, { ok: true });
    }

    /* 我的权益（用户中心用）：未开通/已过期/剩余额度/到期时间 */
    if (p === "/entitlements" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      return send(200, { ok: true, features: FEATURES, labels: FEATURE_LABEL, pricing: pricingOf(), entitlements: entitlementsSummary(who.username) });
    }

    /* 自助开通：扣积分换「时长 + 额度」。积分不足返回 402，前端据此引导充值/找管理员。 */
    if (p === "/entitlements/activate" && req.method === "POST") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      const feature = String((body && body.feature) || "").trim();
      if (!FEATURES.includes(feature)) return send(400, { ok: false, error: "feature 必须是 knowledge 或 memory" });
      if (!rateLimit(`ent:${who.username}`, 10, 60_000)) return send(429, { ok: false, error: "操作太频繁，请稍后再试" });
      const price = pricingOf()[feature];
      const account = pointsOf(who.username);
      if (price.points > 0 && Number(account.balance || 0) < price.points) {
        return send(402, { ok: false, error: "insufficient-points", need: price.points, balance: Number(account.balance || 0) });
      }
      if (price.points > 0) {
        addPoints(who.username, -price.points, "entitlement", `ent:${feature}:${Date.now()}`, `开通${FEATURE_LABEL[feature]} ${price.days} 天`);
      }
      const state = grantFeature(who.username, feature, { days: price.days, quotaMb: price.quotaMb, quota: price.quota, note: "用户自助开通" });
      provisionFor(who.username, feature);
      return send(200, { ok: true, feature, state, balance: pointsOf(who.username).balance, entitlements: entitlementsSummary(who.username) });
    }

    /* 管理员：权益总览 / 开通·续期·停用 / 价格表 */
    if (p === "/admin/entitlements" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const users = db.users.map((u) => ({ username: u.username, role: u.role, disabled: !!u.disabled, entitlements: entitlementsSummary(u.username) }));
      return send(200, { ok: true, features: FEATURES, labels: FEATURE_LABEL, pricing: pricingOf(), users });
    }
    if (p === "/admin/entitlements" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String((body && body.username) || "").trim();
      const feature = String((body && body.feature) || "").trim();
      if (!db.users.some((u) => u.username === target)) return send(404, { ok: false, error: "用户不存在" });
      if (!FEATURES.includes(feature)) return send(400, { ok: false, error: "feature 必须是 knowledge 或 memory" });
      const state = grantFeature(target, feature, {
        disable: body.enabled === false,
        /* ⛔ days 不传 = **只改额度**（保留原到期时间）；传 0 = 永久；传正数 = 叠加续期 */
        days: body.days === undefined ? null : Number(body.days || 0),
        quotaMb: body.quotaMb === undefined ? undefined : Number(body.quotaMb),
        quota: body.quota === undefined ? undefined : Number(body.quota),
        note: String((body && body.note) || `管理员 ${me.username} 操作`),
      });
      if (state.enabled) provisionFor(target, feature);
      return send(200, { ok: true, username: target, feature, state, entitlements: entitlementsSummary(target) });
    }
    if (p === "/admin/pricing" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      if (typeof db.pricing !== "object" || !db.pricing) db.pricing = {};
      for (const f of FEATURES) {
        const incoming = body && body[f];
        if (!incoming || typeof incoming !== "object") continue;
        const cur = { ...DEFAULT_PRICING[f], ...(db.pricing[f] || {}) };
        for (const key of ["points", "days", "quotaMb", "quota"]) {
          if (incoming[key] !== undefined && Number.isFinite(Number(incoming[key]))) cur[key] = Math.max(0, Math.floor(Number(incoming[key])));
        }
        db.pricing[f] = cur;
      }
      persist();
      return send(200, { ok: true, pricing: pricingOf() });
    }

    /* 每用户集成凭据（10-16）：客户端带自己的账号会话来领「知识库 MCP + 记忆 user_key」。
       ⛔ 先查权益**再**建资源：未开通（或已过期）一律不建库、不发钥匙 ⇒ 省资源 + 防白嫖。
       幂等：第一次调用会建库/建端点/建记忆账号，之后每次直接返回同一份。 */
    if (p === "/integrations" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const flags = integrationSecretsOk();
      const ent = entitlementsSummary(who.username);
      const out = {
        ok: true,
        configured: flags,
        entitlements: ent,
        knowledge: { ok: false, error: "not-activated", reason: "未开通知识库（按时长+额度激活后可用）" },
        memory: { ok: false, error: "not-activated", reason: "未开通记忆（按时长+额度激活后可用）" },
      };
      if (ent.knowledge.enabled) {
        try { out.knowledge = await ensureKnowledgeFor(who.username); }
        catch (e) { out.knowledge = { ok: false, error: sanitize(String((e && e.message) || e)) }; }
      }
      if (ent.memory.enabled) {
        try { out.memory = await ensureMemoryFor(who.username); }
        catch (e) { out.memory = { ok: false, error: sanitize(String((e && e.message) || e)) }; }
      }
      return send(200, out);
    }

    if (p === "/points/me" && req.method === "GET") {
      const who = accountWho();
      if (!who) return send(401, { ok: false, error: "unauthorized" });
      const acct = pointsOf(who.username);
      return send(200, {
        ok: true,
        username: who.username,
        balance: acct.balance,
        signupGrant: SIGNUP_GRANT,
        txns: acct.txns.slice(0, 50),
        verify: pointsVerify(who.username),
      });
    }
    if (p === "/admin/points" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const rows = db.users
        .map((u) => {
          const acct = pointsOf(u.username);
          const last = acct.txns[0] || null;
          return { username: u.username, role: u.role, disabled: !!u.disabled, balance: acct.balance, txnCount: acct.txns.length, lastAt: last ? last.at : 0, lastNote: last ? (last.note || last.kind) : "" };
        })
        .filter((r) => !q || r.username.toLowerCase().includes(q))
        .sort((a, b) => b.balance - a.balance);
      return send(200, { ok: true, total: rows.length, signupGrant: SIGNUP_GRANT, users: rows });
    }
    if (p === "/admin/points/grant" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String(body && body.username || "").trim();
      const delta = Number(body && body.delta);
      const note = String(body && body.note || "").slice(0, 200);
      if (!db.users.some((u) => u.username === target)) return send(404, { ok: false, error: "用户不存在" });
      if (!Number.isFinite(delta) || delta === 0) return send(400, { ok: false, error: "分值必须是数字且非 0" });
      /* ref 用"管理员+时间戳+随机"⇒ 每次发放都是一条独立流水，不会被幂等吃掉 */
      const ref = `admin:${me.username}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
      const r = addPoints(target, delta, "grant", ref, note || `管理员 ${me.username} 发放`);
      persist();
      console.log(`[points] ${me.username} 给 ${target} 发放 ${delta}（余额 ${r.balance}）`);
      return send(200, { ok: true, username: target, delta, balance: r.balance, txn: r.txn });
    }
    /* 10-15 管理员接口配置：上游 API 地址/网关密钥（GET 读脱敏回显，POST 覆盖保存）。
       存 data.json.upstream —— 转发逻辑（currentUpstreamBase/currentGatewayKey）热生效，免重启。 */
    if (p === "/admin/upstream" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const o = readUpstreamOverride();
      const key = currentGatewayKey();
      const base = currentUpstreamBase();
      return send(200, {
        ok: true,
        base,
        /* 目录同步地址（可空 = 与上游同址）；同时回显"实际生效的"那个，便于排查 */
        catalogBase: (o && o.catalogBase) || "",
        effectiveCatalogBase: currentCatalogBase(),
        /* 环境变量里的值也回显：管理员能一眼看出"现在到底在用哪个" */
        envBase: WBM_BASE || "",
        insecure: /^http:\/\//i.test(base),
        gatewayKey: key ? key.slice(0, 6) + "***" + key.slice(-4) : "",
        hasKey: Boolean(key),
        source: o ? "admin" : "env",
      });
    }
    if (p === "/admin/upstream" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      /* 10-18：协议适配放宽（http / 裸主机 / 内网 / 端口 / 路径前缀都由 normalizeUpstreamBase 处理） */
      const norm = normalizeUpstreamBase(body && body.base);
      if (!norm.ok) return send(400, { ok: false, error: norm.error });
      /* 目录同步地址（可选）：留空 ⇒ 与上游同址；填了就必须也能归一化 */
      let catalogBase = "";
      if (body && body.catalogBase !== undefined && String(body.catalogBase).trim() !== "") {
        const cnorm = normalizeUpstreamBase(body.catalogBase);
        if (!cnorm.ok) return send(400, { ok: false, error: "目录同步地址：" + cnorm.error });
        catalogBase = cnorm.base;
      }
      const providedKey = String(body && body.gatewayKey || "").trim();
      const prev = db.upstream || {};
      db.upstream = { base: norm.base, catalogBase, gatewayKey: providedKey || prev.gatewayKey || "" };
      persist();
      console.log(`[upstream] ${me.username} 更新上游 API 地址 → ${norm.base}${catalogBase ? `（目录同步 → ${catalogBase}）` : ""}${providedKey ? "（含新网关密钥）" : "（沿用原网关密钥）"}${norm.insecure ? " ⚠️ http 明文" : ""}`);
      return send(200, {
        ok: true, base: norm.base, catalogBase,
        hasKey: Boolean(db.upstream.gatewayKey),
        insecure: norm.insecure,
        warning: norm.insecure ? "http 明文传输：仅建议内网使用" : "",
      });
    }
    /* 连通性测试（10-18 用户令「为上游 API 地址增加连通性测试功能」）。
       ⛔ 只发 GET、绝不发写请求；⛔ 回执不含密钥（只回 hasKey）；
       ⛔ 允许测"还没保存的地址"（body.base 优先）—— 先验再存，避免存了才发现不通。 */
    if (p === "/admin/upstream/test" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const norm = normalizeUpstreamBase(body && body.base ? body.base : currentUpstreamBase());
      if (!norm.ok) return send(400, { ok: false, error: norm.error });
      const key = String(body && body.gatewayKey || "").trim() || currentGatewayKey();
      const started = Date.now();
      /* 依次探测：WBM 专有目录端点 → OpenAI 兼容 /v1/models。
         命中哪个就说明这个地址属于哪一类 —— 管理员据此决定"要不要单独填目录同步地址"。 */
      const probes = [
        { name: "模型目录（WBM）", path: "/api/model-catalog?realm=cn", wantList: true },
        { name: "OpenAI 兼容 /v1/models", path: "/v1/models", wantList: true },
      ];
      const results = [];
      for (const probe of probes) results.push(await probeGet(norm.base, probe, key, "bearer"));
      const best = bestProbe(results);
      console.log(`[upstream] ${me.username} 连通性测试 ${norm.base} → ${best ? "连通" : "不可达"}（${results.map((x) => `${x.status || "ERR"}@${x.ms}ms`).join(" / ")}）`);
      return send(200, {
        ok: Boolean(best),
        base: norm.base,
        insecure: norm.insecure,
        warning: norm.insecure ? "http 明文传输：仅建议内网使用" : "",
        hasKey: Boolean(key),
        elapsedMs: Date.now() - started,
        probes: results,
        message: best
          ? `连通：${best.name}${best.count != null ? `，${best.count} 个模型` : ""}（${best.ms}ms）`
          : "不可达：两个端点都没成功 —— 看下面每一行的原因",
      });
    }
    /* ── 知识库 / 记忆空间上游（10-18 用户令「为知识库和记忆空间预留可配置的接口」）────
       GET  回显：面板值 + **当前生效值** + 环境变量原值（管理员一眼看出"到底在用哪个"）
       POST 保存：字段留空 = **回退环境变量**（⛔ 不是清空）；保存后 applyServiceOverrides **热生效**
       POST .../test：只发 GET 的连通性探测（⛔ 绝不发写请求；⛔ 回执不含密钥）
       ⛔ 地址走 normalizeUpstreamBase（http / 裸主机 / 内网 / 端口 / 路径前缀都接受）。 */
    if (p === "/admin/services" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const kb = db.services.kb || {};
      const mem = db.services.memory || {};
      const mask = (v) => (v ? String(v).slice(0, 6) + "***" + String(v).slice(-4) : "");
      return send(200, {
        ok: true,
        kb: {
          base: kb.base || "", key: mask(kb.key), hasKey: Boolean(kb.key),
          llmModelId: kb.llmModelId || "", embedModelId: kb.embedModelId || "", vlmModelId: kb.vlmModelId || "",
          effectiveBase: WEKNORA_BASE, effectiveHasKey: Boolean(WEKNORA_ADMIN_KEY),
          envBase: WEKNORA_ENV_BASE, envHasKey: Boolean(WEKNORA_ENV_ADMIN_KEY),
        },
        memory: {
          base: mem.base || "", proxyBase: mem.proxyBase || "", key: mask(mem.key), hasKey: Boolean(mem.key),
          instance: mem.instance || "",
          effectiveBase: MEMHUB_BASE, effectiveProxyBase: MEMHUB_PROXY_BASE, effectiveHasKey: Boolean(MEMHUB_ADMIN_KEY),
          envBase: MEMHUB_ENV_BASE, envProxyBase: MEMHUB_ENV_PROXY_BASE, envHasKey: Boolean(MEMHUB_ENV_ADMIN_KEY),
        },
        secrets: integrationSecretsOk(),
      });
    }
    if (p === "/admin/services" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const kbIn = (body && body.kb) || {};
      const memIn = (body && body.memory) || {};
      const normOne = (raw, label) => {
        const s = String(raw == null ? "" : raw).trim();
        if (!s) return { ok: true, value: "" };                    // 留空 ⇒ 回退环境变量
        const n = normalizeUpstreamBase(s);
        return n.ok ? { ok: true, value: n.base } : { ok: false, error: label + "：" + n.error };
      };
      const kbBase = normOne(kbIn.base, "知识库地址");
      if (!kbBase.ok) return send(400, { ok: false, error: kbBase.error });
      const memBase = normOne(memIn.base, "记忆地址");
      if (!memBase.ok) return send(400, { ok: false, error: memBase.error });
      const memProxy = normOne(memIn.proxyBase, "记忆代理地址");
      if (!memProxy.ok) return send(400, { ok: false, error: memProxy.error });
      const keep = (v) => String(v == null ? "" : v).trim();
      db.services.kb = {
        base: kbBase.value,
        key: keep(kbIn.key),
        llmModelId: keep(kbIn.llmModelId),
        embedModelId: keep(kbIn.embedModelId),
        vlmModelId: keep(kbIn.vlmModelId),
      };
      db.services.memory = {
        base: memBase.value,
        proxyBase: memProxy.value,
        key: keep(memIn.key),
        instance: keep(memIn.instance),
      };
      persist();
      applyServiceOverrides();                                     // ⛔ 热生效（免重启）
      console.log(`[services] ${me.username} 更新：知识库 → ${WEKNORA_BASE}（key ${WEKNORA_ADMIN_KEY ? "已配" : "未配"}）· 记忆 → ${MEMHUB_BASE}（代理 ${MEMHUB_PROXY_BASE}，key ${MEMHUB_ADMIN_KEY ? "已配" : "未配"}）`);
      return send(200, {
        ok: true,
        kb: { effectiveBase: WEKNORA_BASE, effectiveHasKey: Boolean(WEKNORA_ADMIN_KEY) },
        memory: { effectiveBase: MEMHUB_BASE, effectiveProxyBase: MEMHUB_PROXY_BASE, effectiveHasKey: Boolean(MEMHUB_ADMIN_KEY) },
      });
    }
    if (p === "/admin/services/test" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const which = String((body && body.which) || "kb").trim() === "memory" ? "memory" : "kb";
      const isKb = which === "kb";
      const norm = normalizeUpstreamBase((body && body.base) || (isKb ? WEKNORA_BASE : MEMHUB_BASE));
      if (!norm.ok) return send(400, { ok: false, error: norm.error });
      const key = String(body && body.key || "").trim() || (isKb ? WEKNORA_ADMIN_KEY : MEMHUB_ADMIN_KEY);
      const started = Date.now();
      /* ⛔ 只用**读端点**探测：
         · WeKnora：`GET /api/v1/knowledge-bases`（X-API-Key）—— 200 且能数出条数最理想
         · MemHub：它没有公开的健康端点，用 `GET /api/v1/meta/user/create`（预期 405/404 ——
           收到任何 <500 的响应就说明服务与路由都在），再兜底 `GET /` */
      const probes = isKb
        ? [{ name: "知识库列表", path: "/api/v1/knowledge-bases?page_size=1", wantList: true }]
        : [
          { name: "记忆服务（建用户端点，GET 预期 405）", path: "/api/v1/meta/user/create", wantList: false },
          { name: "记忆服务根路径", path: "/", wantList: false },
        ];
      const results = [];
      for (const probe of probes) results.push(await probeGet(norm.base, probe, key, isKb ? "x-api-key" : "bearer"));
      const best = bestProbe(results);
      console.log(`[services] ${me.username} 测试 ${which} ${norm.base} → ${best ? "连通" : "不可达"}（${results.map((x) => `${x.status || "ERR"}@${x.ms}ms`).join(" / ")}）`);
      return send(200, {
        ok: Boolean(best),
        which, base: norm.base,
        insecure: norm.insecure,
        warning: norm.insecure ? "http 明文传输：仅建议内网使用" : "",
        hasKey: Boolean(key),
        elapsedMs: Date.now() - started,
        probes: results,
        message: best
          ? `连通：${best.name}${best.count != null ? `，${best.count} 条` : ""}（${best.ms}ms）`
          : "不可达：看下面每一行的原因",
      });
    }
    /* ── 运维：更新 / 重启（10-18 用户令「加上更新，重启功能」）────────────────
       ⛔⛔ 高危接口（能改代码、能杀进程），三条硬约束：
          ① 仅 admin；② 必须显式 `{ confirm: true }`；③ 更新只做 `git pull --ff-only`
             （不 merge、不 rebase —— 冲突时宁可失败也不要在生产目录里留下半截合并）。
       ⛔ 重启用 `process.exit(0)` 交给 systemd 的 `Restart=always` 拉起，
          **不要**自己 spawn 新进程：那会出现两个实例抢同一份 data.json。
       ⛔ 必须**先 send 响应再退出**，否则前端只看到"连接被重置"。 */
    if (p === "/admin/system/restart" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      if (!body || body.confirm !== true) return send(400, { ok: false, error: "需要确认（confirm: true）" });
      console.log(`[ops] ${me.username} 请求重启服务`);
      send(200, { ok: true, restarting: true, message: "正在重启，约 3 秒后自动恢复" });
      setTimeout(() => process.exit(0), 400);
      return;
    }
    if (p === "/admin/system/update" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      if (!body || body.confirm !== true) return send(400, { ok: false, error: "需要确认（confirm: true）" });
      const repoRoot = path.resolve(__dirname, "..");
      if (!fs.existsSync(path.join(repoRoot, ".git"))) {
        return send(400, {
          ok: false,
          error: "当前安装不是 git 部署（目录里没有 .git），无法一键更新。",
          hint: "两种做法：① 用分发包的方式重装（git clone + deploy/install.sh）；② 手动把新版 server-account/ 与 web/ 覆盖过来，再点「重启服务」。",
        });
      }
      const { execFile } = require("node:child_process");
      const run = (args) => new Promise((resolve) => {
        execFile("git", args, { cwd: repoRoot, timeout: 60000 }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || (err && err.message) || "").trim() });
        });
      });
      const before = await run(["rev-parse", "--short", "HEAD"]);
      const pull = await run(["pull", "--ff-only"]);
      if (!pull.ok) {
        /* 兜底：ff-only 失败一般不会改工作区，但仍回到 pull 前的 commit，避免留下脏树 */
        await run(["reset", "--hard", "ORIG_HEAD"]);
        console.log(`[ops] ${me.username} 更新失败：${pull.err.slice(0, 200)}`);
        return send(500, { ok: false, error: "更新失败：" + (pull.err || "未知错误"), detail: pull.out });
      }
      const after = await run(["rev-parse", "--short", "HEAD"]);
      const changed = before.out !== after.out;
      console.log(`[ops] ${me.username} 更新${changed ? `成功 ${before.out}→${after.out}` : "检查完成（无变化）"}`);
      send(200, {
        ok: true, restarting: true, changed,
        from: before.out, to: after.out,
        output: pull.out.slice(0, 1200),
        message: changed ? `已更新 ${before.out} → ${after.out}，正在重启` : "代码已是最新（无变化），正在重启",
      });
      setTimeout(() => process.exit(0), 400);
      return;
    }
    /* ── 邀请码：用户侧校验 + 管理端生成/监控（10-16）────────────────────────── */
    if (p === "/invite/check" && req.method === "GET") {
      /* ⛔ 必须限流：这是**未鉴权**端点 —— 不限流就等于给出"批量枚举有效码"的通道
         （8 位十六进制 = 2^32 空间，单机慢但分布式可行）。与注册同档强度：每 IP 每分钟 30 次。
         ⛔ 回执仍**不含剩余额度**（否则拿一个码就能读出它被用掉多少）。 */
      if (!rateLimit(`invcheck:${ip}`, 30, 60_000)) return send(429, { ok: false, error: "too-many-requests" });
      const row = inviteRow(url.searchParams.get("code"));
      const blocker = row ? inviteBlocker(row) : "";
      /* ⛔ 只回"能不能用 + 原因"，**不回剩余额度**（否则任何人都能拿一个码探测它用掉多少） */
      return send(200, { ok: true, valid: Boolean(row) && !blocker, reason: blocker || (row ? "" : "invite-not-found") });
    }
    if (p === "/admin/invites" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const all = inviteList();
      const rows = q ? all.filter((r) => r.code.includes(q) || String(r.note || "").toLowerCase().includes(q)) : all;
      return send(200, {
        ok: true,
        invites: rows,
        totals: {
          codes: all.length,
          activeCodes: all.filter((r) => !r.disabled && !r.expired && (r.maxUses === 0 || r.usedCount < r.maxUses)).length,
          uses: all.reduce((n, r) => n + r.usedCount, 0),
          accounts: db.users.filter((u) => u.inviteCode).length,
        },
        /* 与邀请码无关的兜底通道状态：管理端要能看出"为什么现在还允许无码注册" */
        masterCodeConfigured: Boolean(REGISTER_INVITE_CODE),
        inviteRequired: inviteRequired(),
      });
    }
    if (p === "/admin/invites" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const note = String((body && body.note) || "").trim().slice(0, 40);
      const maxUses = Math.max(0, Math.min(10000, Number((body && body.maxUses) || 0) | 0));
      const days = Math.max(0, Math.min(3650, Number((body && body.expiresInDays) || 0) | 0));
      let code = "";
      for (let i = 0; i < 20 && !code; i += 1) {
        const candidate = crypto.randomBytes(4).toString("hex");
        if (!db.invites[candidate]) code = candidate;
      }
      if (!code) return send(500, { ok: false, error: "生成失败，请重试" });
      db.invites[code] = {
        code, note, createdBy: me.username, createdAt: Date.now(),
        maxUses, usedCount: 0, usedBy: [], disabled: false,
        expiresAt: days ? Date.now() + days * 86400000 : 0, lastUsedAt: 0,
      };
      persist();
      console.log(`[invite] ${me.username} 生成邀请码 ${code}（上限=${maxUses || "不限"}，有效期=${days ? days + "天" : "永久"}，备注=${note || "无"}）`);
      return send(200, { ok: true, invite: inviteView(db.invites[code]) });
    }
    if (p === "/admin/invites/update" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const row = inviteRow(body && body.code);
      if (!row) return send(404, { ok: false, error: "邀请码不存在" });
      /* ⛔ code 本身不可改（改了等于换码，已注册账号的来源指针会悬空） */
      if (body.note !== undefined) row.note = String(body.note || "").trim().slice(0, 40);
      if (body.disabled !== undefined) row.disabled = Boolean(body.disabled);
      if (body.maxUses !== undefined) row.maxUses = Math.max(0, Math.min(10000, Number(body.maxUses) || 0) | 0);
      if (body.expiresInDays !== undefined) {
        const d = Math.max(0, Math.min(3650, Number(body.expiresInDays) || 0) | 0);
        row.expiresAt = d ? Date.now() + d * 86400000 : 0;
      }
      persist();
      console.log(`[invite] ${me.username} 调整邀请码 ${row.code}（停用=${row.disabled}，上限=${row.maxUses}）`);
      return send(200, { ok: true, invite: inviteView(row) });
    }
    if (p === "/admin/invites/accounts" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const row = inviteRow(url.searchParams.get("code"));
      if (!row) return send(404, { ok: false, error: "邀请码不存在" });
      const accounts = db.users
        .filter((u) => u.inviteCode === row.code)
        .map((u) => ({
          username: u.username, createdAt: u.createdAt || 0, lastLogin: u.lastLogin || 0,
          disabled: Boolean(u.disabled),
          balance: (db.points[u.username] && db.points[u.username].balance) || 0,
        }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return send(200, { ok: true, code: row.code, note: row.note || "", usedCount: Number(row.usedCount || 0), accounts });
    }
    /* ── 10-15 管理员界面补齐：用户管理 + 磁盘余量 ─────────────────────────── */
    if (p === "/admin/disk" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const st = await fs.promises.statfs("/");
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      return send(200, { ok: true, totalBytes: total, freeBytes: free, usedBytes: total - free });
    }
    if (p === "/admin/users" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const rows = db.users.map((u) => ({
        username: u.username, role: u.role, disabled: Boolean(u.disabled),
        lastLogin: u.lastLogin || 0, createdAt: u.createdAt || 0,
        inviteCode: u.inviteCode || "",
        balance: (db.points[u.username] && db.points[u.username].balance) || 0,
        quotaBytes: storageLimitFor(u.username),
        quotaOverride: Boolean(db.storageQuota && db.storageQuota[u.username]),
        usedBytes: syncUsageBytes(u.username),
      }));
      return send(200, { ok: true, users: rows });
    }
    if (p === "/admin/users/storage" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String(body && body.username || "").trim();
      const gb = Number(body && body.quotaGB);
      if (!db.users.some((u) => u.username === target)) return send(404, { ok: false, error: "用户不存在" });
      if (!Number.isFinite(gb) || gb <= 0 || gb > 1024) return send(400, { ok: false, error: "配额必须是 0~1024 之间的 GB 数" });
      db.storageQuota = db.storageQuota || {};
      db.storageQuota[target] = Math.round(gb * 1024 * 1024 * 1024);
      persist();
      console.log(`[admin] ${me.username} 将 ${target} 的云存储配额设为 ${gb} GB`);
      return send(200, { ok: true, username: target, quotaBytes: db.storageQuota[target] });
    }
    if (p === "/admin/users/toggle" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String(body && body.username || "").trim();
      const disabled = Boolean(body && body.disabled);
      const u = db.users.find((x) => x.username === target);
      if (!u) return send(404, { ok: false, error: "用户不存在" });
      if (u.role === "admin") return send(400, { ok: false, error: "管理员账号不允许禁用/启用" });
      u.disabled = disabled;
      if (disabled) { /* 禁用即踢下线：清其全部会话 */ for (const k of Object.keys(db.sessions)) { if (db.sessions[k].username === target) delete db.sessions[k]; } }
      persist();
      console.log(`[admin] ${me.username} ${disabled ? "禁用" : "启用"}了 ${target}`);
      return send(200, { ok: true, username: target, disabled });
    }
    if (p === "/admin/users/reset" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String(body && body.username || "").trim();
      const password = String(body && body.password || "");
      const u = db.users.find((x) => x.username === target);
      if (!u) return send(404, { ok: false, error: "用户不存在" });
      if (password.length < 6) return send(400, { ok: false, error: "新密码至少 6 位" });
      u.salt = crypto.randomBytes(16).toString("hex");
      u.hash = hashPassword(password, u.salt);
      u.failCount = 0; u.lockUntil = 0;
      for (const k of Object.keys(db.sessions)) { if (db.sessions[k].username === target) delete db.sessions[k]; }
      persist();
      console.log(`[admin] ${me.username} 重置了 ${target} 的密码（该用户全部会话已下线）`);
      return send(200, { ok: true, username: target });
    }
    if (p === "/admin/users/delete" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String(body && body.username || "").trim();
      const u = db.users.find((x) => x.username === target);
      if (!u) return send(404, { ok: false, error: "用户不存在" });
      if (u.role === "admin") return send(400, { ok: false, error: "管理员账号不允许删除" });
      db.users = db.users.filter((x) => x.username !== target);
      /* ⛔⛔ 逐个 delete 前必须先确认整张表存在：**对 undefined 取下标再 delete** 会抛
         TypeError: Cannot convert undefined or null to object ⇒ 删号直接 500
         （10-16 实测踩到：库/勾选/令牌/配额里只要有一张还没建过，整条删除就废）。
         ⛔ 同时补上 **权益与集成凭据** 两张表：漏清会留下孤儿 —— 账号没了，
         db.entitlements / db.integrations 里还挂着该用户的到期时间、库 id 与记忆钥匙。 */
      for (const table of ["points", "userModels", "proxyTokens", "storageQuota", "entitlements", "integrations"]) {
        if (db[table] && typeof db[table] === "object") delete db[table][target];
      }
      for (const k of Object.keys(db.sessions || {})) { if (db.sessions[k] && db.sessions[k].username === target) delete db.sessions[k]; }
      persist();
      console.log(`[admin] ${me.username} 删除了用户 ${target}（含积分/勾选/令牌/配额与全部会话）`);
      return send(200, { ok: true, username: target });
    }
    /* 清理某账号在**外部**留下的资源（知识库 + 只读端点 + 记忆用户）。
       ⛔ 与 /admin/users/delete 的分工：那个只清本服务数据，这个清外部；
         两个都不做对方的活 —— 所以删号后想彻底干净，要两个都调（或先在这里清，再删号）。 */
    if (p === "/admin/purge-external" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const target = String((body && body.username) || "").trim();
      if (!/^[A-Za-z0-9_-]{3,24}$/.test(target)) return send(400, { ok: false, error: "账号名不合法" });
      const result = { username: target, knowledge: null, memory: null };

      /* ① 知识库：按名字 `u-<账号名>` 找库 ⇒ 先删库下的端点，再删库（顺序不能反：
            端点引用着库，先删库会让端点成为悬空引用）。 */
      if (!WEKNORA_ADMIN_KEY) {
        result.knowledge = { ok: false, error: "knowledge-not-configured" };
      } else {
        try {
          const kbName = `u-${target.replace(/[^\w.-]+/g, "_").slice(0, 40)}`;
          const list = await weknoraAdmin("/api/v1/knowledge-bases?page_size=100");
          const mine = (((list && list.data) || []).filter((kb) => kb && kb.name === kbName));
          const removed = [];
          for (const kb of mine) {
            /* ⛔⛔ 归属核验必须在**客户端侧**做：上游的 `?knowledge_base_id=` 过滤**不可信**
               （10-16 实测：带了这个参数照样返回全部端点 ⇒ 按它删就删了别人的端点，事故）。
               只删"knowledge_base_ids 里确实含本库 id"的端点；过滤后为空 ⇒ 一个都不删。 */
            const eps = await weknoraAdmin("/api/v1/mcp-endpoints").catch(() => null);
            const mineEps = (((eps && eps.data) || [])).filter((ep) => {
              const ids = Array.isArray(ep && ep.knowledge_base_ids) ? ep.knowledge_base_ids : [];
              return ids.includes(kb.id) || (ep && ep.knowledge_base_id === kb.id);
            });
            for (const ep of mineEps) {
              await weknoraAdmin(`/api/v1/mcp-endpoints/${ep.id}`, { method: "DELETE" }).catch(() => null);
              removed.push(`endpoint:${ep.id}`);
            }
            await weknoraAdmin(`/api/v1/knowledge-bases/${kb.id}`, { method: "DELETE" });
            removed.push(`kb:${kb.id}`);
          }
          result.knowledge = { ok: true, found: mine.length, removed };
        } catch (error) {
          result.knowledge = { ok: false, error: sanitize(String((error && error.message) || error)) };
        }
      }

      /* ② 记忆：外部侧按 `chc-<账号名>` 建的用户。⛔ 删除接口待确认语义（见文档 §7），
             这里**如实回报未做**，不猜接口、不假装删过。 */
      result.memory = { ok: false, error: "memory-purge-manual", note: "记忆用户需在 Memory Hub 侧删除（接口语义待确认）" };

      console.log(`[admin] ${me.username} 清理外部资源 ${target}：知识库=${JSON.stringify(result.knowledge)} `);
      return send(200, { ok: true, ...result });
    }

    /* 10-15 用户令：积分流水支持清除（只清记录，余额不动，不可恢复）。 */
    if (p === "/points/clear" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const acct = pointsOf(me.username);
      const count = Array.isArray(acct.txns) ? acct.txns.length : 0;
      const balance = Number(acct.balance) || 0;
      /* ⛔ 20:1x 用户实测「账目异常」根因：清理只清明细不记结转 ⇒ sum(txns)=0 ≠ balance
         ⇒ pointsVerify 判不一致（界面红标"账目异常"）。修法：清空后写一条**结转流水**，
         delta = 当前余额（kind=carryover）⇒ 账目重新自洽，且用户仍能看到"历史已清"的痕迹。 */
      acct.txns = [{ id: 1, at: Date.now(), delta: Math.round(balance * 100) / 100, kind: "carryover",
        ref: `carryover:${Date.now()}`, note: `期初结转（清除历史记录 ${count} 条）`, after: balance }];
      persist();
      console.log(`[points] ${me.username} 清除了积分流水（${count} 条）并写入期初结转 ${balance}`);
      return send(200, { ok: true, cleared: count, balance, carriedOver: balance });
    }
    if (p === "/points/verify" && req.method === "GET") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      return send(200, { ok: true, ...pointsVerify(me.username) });
    }
    if (p === "/device/heartbeat" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(403, { ok: false, error: "account-disabled" });
      device.lastSeen = Date.now();
      persist();
      return send(200, { ok: true, account: user.username });
    }
    if (p === "/device/update/check" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const device = findDeviceByToken(token);
      if (!device) return send(401, { ok: false, error: "unauthorized" });
      const user = db.users.find((u) => u.username === device.username);
      if (!user || user.disabled) return send(403, { ok: false, error: "account-disabled" });
      device.lastSeen = Date.now();
      persist();
      return send(200, { ok: true, ...readUpdateMeta() });
    }
    if (p === "/me" && req.method === "GET") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      return send(200, { ok: true, account: publicView(me), server: { baseUrl: publicBaseOf(req) } });
    }
    if (p === "/logout" && req.method === "POST") {
      const header = String(req.headers.authorization || "");
      if (header.startsWith("Bearer ")) { delete db.sessions[crypto.createHash("sha256").update(header.slice(7).trim()).digest("hex")]; persist(); }
      return send(200, { ok: true });
    }
    if (p === "/password" && req.method === "POST") {
      if (!me) return send(401, { ok: false, error: "unauthorized" });
      const body = await readBody();
      if (!verifyPassword(me, body.oldPassword || "")) return send(401, { ok: false, error: "原密码不对" });
      if (!passwordOk(body.newPassword)) return send(400, { ok: false, error: "新密码至少 8 位" });
      me.salt = crypto.randomBytes(16).toString("hex"); me.hash = hashPassword(body.newPassword, me.salt); persist();
      return send(200, { ok: true });
    }

    /* 管理员 */
    if (p.startsWith("/admin/")) {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const target = db.users.find((u) => u.username === decodeURIComponent(p.split("/")[3] || ""));
      if (p === "/admin/users" && req.method === "GET") {
        return send(200, { ok: true, users: db.users.map(publicView) });
      }
      if (!target) return send(404, { ok: false, error: "用户不存在" });
      if (target.username === me.username && p.endsWith("/delete")) return send(400, { ok: false, error: "不能删除自己" });
      if (p.endsWith("/disable") && req.method === "POST") { target.disabled = true; db.sessions = Object.fromEntries(Object.entries(db.sessions).filter(([, s]) => s.username !== target.username)); persist(); return send(200, { ok: true, account: publicView(target) }); }
      if (p.endsWith("/enable") && req.method === "POST") { target.disabled = false; target.lockUntil = 0; target.failCount = 0; persist(); return send(200, { ok: true, account: publicView(target) }); }
      if (p.endsWith("/reset-password") && req.method === "POST") {
        const body = await readBody();
        if (!passwordOk(body.password)) return send(400, { ok: false, error: "新密码至少 8 位" });
        target.salt = crypto.randomBytes(16).toString("hex"); target.hash = hashPassword(body.password, target.salt);
        target.failCount = 0; target.lockUntil = 0; persist();
        return send(200, { ok: true });
      }
      if (p.endsWith("/delete") && req.method === "POST") {
        db.users = db.users.filter((u) => u.username !== target.username);
        db.sessions = Object.fromEntries(Object.entries(db.sessions).filter(([, s]) => s.username !== target.username));
        persist();
        return send(200, { ok: true });
      }
    }

    return send(404, { ok: false, error: "not-found" });
  } catch (error) {
    return send(400, { ok: false, error: error.message === "bad-json" ? "请求格式不对" : error.message });
  }
});

/* ── CLI：签发管理员 ──────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
if (argv[0] === "--init-admin") {
  const [, username, password] = argv;
  if (!usernameOk(username) || !passwordOk(password)) {
    console.error("用法：node server.js --init-admin <用户名> <密码>（用户名 3~24 位字母数字；密码 ≥8 位）");
    process.exit(1);
  }
  if (db.users.some((u) => u.role === "admin")) { console.error("已存在管理员；如需再建，请先手动编辑数据文件。"); process.exit(1); }
  db.users.push(makeUser(username, password, "admin"));
  persist();
  console.log(`管理员「${username}」已创建 → ${DATA_FILE}`);
  process.exit(0);
}

console.log(
  "[wbm] 限时福利接入：" +
    (WBM_BASE && WBM_TOKEN ? "已配置（地址与 token 均来自凭据/环境，不落日志）" : "未配置（缺 WBM_BASE 或 wbm-token 凭据）") +
    "｜网关密钥：" + (WBM_GATEWAY_KEY ? "已配置" : "未配置")
);
server.listen(PORT, "127.0.0.1", () => console.log(`[accounts] 账号服务就绪 127.0.0.1:${PORT}（users=${db.users.length}, file=${DATA_FILE}）`));

/* ── 一次性补齐（10-16）：老的权益记录没有"容量"字段 ⇒ 按当前默认补上 ──────────────
   背景：容量是后加的（知识库/记忆各 1 GB、互相独立），早先激活的账号 quotaMb 是 0，
   不在页面上就永远看不到容量。这里在启动时补一次；管理员之后可以显式改成 0（不限）。
   ⛔ 放在文件末尾执行：此时 db 已完成加载（`let db` 在前文初始化）。 */
(function migrateLegacyQuotaMb() {
  try {
    const price = DEFAULT_PRICING;
    let dirty = false;
    for (const ent of Object.values(db.entitlements || {})) {
      if (!ent || typeof ent !== "object") continue;
      for (const feature of FEATURES) {
        const slot = ent[feature];
        if (!slot || !slot.enabled) continue;
        const def = Number((price[feature] || {}).quotaMb || 0);
        if (def > 0 && !Number(slot.quotaMb || 0)) { slot.quotaMb = def; dirty = true; }
      }
    }
    if (dirty) { persist(); console.log("[migrate] 已为历史权益补齐默认容量额度"); }
  } catch (e) { console.warn("[migrate] 容量补齐失败（不影响启动）：" + sanitize(String((e && e.message) || e))); }
})();
