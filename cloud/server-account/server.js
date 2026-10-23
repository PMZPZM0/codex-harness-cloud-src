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
/* 本服务版本（10-18「云端管理加更新功能」）：
   ⛔⛔ 读**自己这份部署**的 VERSION —— 先看 server.js 同目录（摊平部署），再看上级（分发包的 server-account/）。
      曾经只读 `..`，主站的 `..` 是 `/home/ubuntu`（没有 VERSION）⇒ 版本恒为 dev，
      而比对的是分发仓的版本号 ⇒ **永远显示"有新版本"**（用户实测）。
   ⛔ 不写死在代码里：否则每次发版要改两处，迟早不一致。 */
const APP_VERSION = (() => {
  for (const p of [path.join(__dirname, "VERSION"), path.join(__dirname, "..", "VERSION")]) {
    try {
      const v = String(fs.readFileSync(p, "utf8")).trim();
      if (v) return v;
    } catch { /* 继续找下一个 */ }
  }
  return "dev";
})();
/** 可自部署的那个仓（面板「获取可部署版本」指向它）。 */
const DEPLOY_REPO = "https://github.com/PMZPZM0/codex-cloud-assistant";
/** **该跟谁比版本**（10-18）：分发包比自己的仓；主站（非 git + 有 selfupdate.sh）比云助手仓。
 *  ⛔ 拿分发仓的版本号去比主站，必然"永远有新版本" —— 这是之前那个 bug 的第二半。 */
const UPDATE_REPO = (() => {
  const envRepo = String(process.env.HARNESS_UPDATE_REPO || "").trim();
  if (envRepo) return envRepo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const isGit = (() => { try { return fs.existsSync(path.join(__dirname, "..", ".git")); } catch { return false; } })();
  const hasSelfUpdate = (() => {
    for (const p of [path.join(__dirname, "selfupdate.sh"), path.join(__dirname, "..", "selfupdate.sh")]) {
      try { if (fs.existsSync(p)) return true; } catch { /* ignore */ }
    }
    return false;
  })();
  return (!isGit && hasSelfUpdate) ? "PMZPZM0/codex-harness-cloud-src" : "PMZPZM0/codex-cloud-assistant";
})();
const UPDATE_REPO_URL = "https://github.com/" + UPDATE_REPO;
/** 版本信息的来源（10-18 改**清单驱动**）：
 *  · 云助手仓 ⇒ `cloud/manifest.json`（含 version + 文件列表，发版只改它）
 *  · 分发仓   ⇒ 根 `VERSION`（它是 git 部署，清单由 git 自己管）
 *  ⛔ 路径写错的话所有镜像都会 404，面板就永远"查不到最新版"。 */
const UPDATE_VERSION_PATH = UPDATE_REPO === "PMZPZM0/codex-harness-cloud-src" ? "cloud/manifest.json" : "VERSION";
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
  return { ok: true, baseUrl: `${MEMHUB_PROXY_BASE}/claude-code/default/v1`, userKey: cur.memKey, instanceId: MEMHUB_INSTANCE, apiKeyHeader: "X-Tdai-User-Key" };
}

/* ── 10-23 管理端「成员 / 模型」支撑函数 ─────────────────────────────────────── */

/** 知识库**后台界面**地址（与 API 地址分离）。
    ⛔ 为什么必须分开：WeKnora 的 API 在 8080、前端界面在 8081（官方 compose 默认）。
       只配了 API 地址时「打开后台」会打开 `:8080/`，浏览器里只有一句
       `{"error":"Unauthorized: missing authentication"}`（10-23 用户实拍）。
    ⛔ 只在端口恰好是 8080 时推导成 8081；其它情况（如 https://kb.域名 由反代分发到前端）
       仍用 API 地址 —— 反代通常同源，猜端口反而会打空。 */
function kbUiBase() {
  const cur = (db.services && db.services.kb) || {};
  const own = String(cur.uiBase || "").trim().replace(/\/+$/, "");
  if (own) return own;
  try {
    const u = new URL(WEKNORA_BASE);
    if (u.port === "8080") { u.port = "8081"; return u.toString().replace(/\/+$/, ""); }
  } catch { /* 地址不合法 ⇒ 原样返回，前端会显示"未配置" */ }
  return WEKNORA_BASE;
}

/** WeKnora 里**已注册的模型**（管理端下拉数据源）。
    ⛔ 只读，不改任何东西；拉不到就让前端回落手填（不能因为上游抽风就把配置框变成死框）。
    · `baseUrl` / `provider` 来自 `parameters`；`hasKey` 来自 `credentials.api_key.configured`
      （⛔ 只知道"配没配"，密钥本身永远不会从 WeKnora 回传）。 */
async function weknoraModelList() {
  const j = await weknoraAdmin("/api/v1/models");
  const rows = (j && (j.data || j.models)) || [];
  return rows.map((m) => ({
    id: String(m.id || ""),
    name: String(m.name || ""),
    title: String(m.display_name || m.name || ""),
    type: String(m.type || ""),
    source: String(m.source || ""),
    note: String(m.description || ""),
    baseUrl: String((m.parameters && m.parameters.base_url) || ""),
    provider: String((m.parameters && m.parameters.provider) || ""),
    hasKey: Boolean(m.credentials && m.credentials.api_key && m.credentials.api_key.configured),
    builtin: Boolean(m.is_builtin),
  })).filter((m) => m.id);
}

/** 知识库模型的三种类型（WeKnora 的 `type` 字段是大小写敏感的枚举）。 */
const KB_MODEL_TYPES = ["KnowledgeQA", "Embedding", "VLLM"];

/** 成员行：把「权益状态」与「已下发的集成凭据」合成一行（⛔ 绝不下发明文密钥）。 */
function memberRow(u, feature) {
  const st = featureState(u.username, feature);
  const it = (db.integrations && db.integrations[u.username]) || {};
  const mask = (v) => (v ? String(v).slice(0, 6) + "***" + String(v).slice(-4) : "");
  const isKb = feature === "knowledge";
  return {
    username: u.username,
    role: u.role,
    accountDisabled: Boolean(u.disabled),
    enabled: st.enabled,
    expired: st.expired,
    expiresAt: st.expiresAt,
    grantedAt: st.grantedAt,
    quotaMb: st.quotaMb,
    usedMb: st.usedMb,
    quota: st.quota,
    usedCount: st.usedCount,
    resourceId: isKb ? String(it.kbId || "") : String(it.memUserId || ""),
    resourceName: isKb ? String(it.kbName || "") : "",
    endpoint: isKb ? String(it.mcpUrl || "") : "",
    keyMask: mask(it.memKey),
    hasResource: isKb ? Boolean(it.kbId) : Boolean(it.memKey),
  };
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
/* ═══ 10-22 移植自 codex-cloud-assistant 1.0.18：模型目录的候选端点 / 多形状解析 / 上游倍率 / 映射 ═══ */

/* 最近一次目录同步失败原因（面板「模型管理」直接显示，不必先点一次同步才知道为什么空）。 */

let lastCatalogError = null;

function splitUpstreamBase(base) {
  const b = String(base || "").trim().replace(/\/+$/, "");
  return { root: b.replace(/\/v1$/i, ""), openai: /\/v1$/i.test(b) ? b : `${b}/v1` };
}

/** 上游 URL（10-23）：管理员填的地址**带不带 /v1 都合法**（两种都有人填）。
 *  ⛔ 直接 `${base}/v1/...` 拼会在"已经带 /v1"的部署上拼成 `/v1/v1/...` ⇒
 *     上游回一句 `{"detail":"Method Not Allowed"}`，客户端只看到 405、完全不知为什么
 *     （客户机实测：upstream.base = https://wb.ppz123.asia/v1）。统一走这里。 */
function upstreamUrl(pathAfterV1) {
  const { openai } = splitUpstreamBase(currentUpstreamBase());
  return `${openai}/${String(pathAfterV1 || "").replace(/^\/+/, "")}`;
}

function catalogCandidates(base) {
  const { root, openai } = splitUpstreamBase(base);
  const list = [
    { name: "管理目录 /api/model-catalog", url: `${root}/api/model-catalog?realm=cn` },
    { name: "OpenAI 兼容 /v1/models", url: `${openai}/models` },
    { name: "通用 /models", url: `${root}/models` },
  ];
  /* 10-22 部署实测：按本仓文档装出来的记忆网关，API 根是
     `https://<域名>/claude-code/<实例>`（默认实例 default），而管理员很容易把**控制台地址**
     （`https://<域名>`，会 302 到 /login）填进来。这里补一条本产品自带形态的候选：
     地址没带 /claude-code/ 前缀时，顺手试一下默认实例的模型列表。 */
  if (!/\/claude-code\//i.test(root)) {
    list.push({ name: "记忆网关 /claude-code/default/v1/models", url: `${root}/claude-code/default/v1/models` });
  }
  return list;
}

function modelsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const arr = (v) => (Array.isArray(v) ? v : null);
  return arr(payload.data) || arr(payload.models) || arr(payload.list) || arr(payload.items)
    || arr(payload.result) || arr(payload.result && payload.result.data) || arr(payload.result && payload.result.models)
    || arr(payload.data && payload.data.models) || arr(payload.data && payload.data.list) || null;
}

async function fetchModelsByProtocol(url, key, mode) {
  const headers = !key
    ? {}
    : mode === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${key}` };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  return modelsFromPayload(payload);
}

async function readUpstreamRates(base, key) {
  const { root, openai } = splitUpstreamBase(base);
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const perModel = new Map();
  let global = null;
  let source = "";
  try {
    const res = await fetch(`${root}/api/pricing`, { headers, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      const rows = Array.isArray(j) ? j : Array.isArray(j && j.data) ? j.data : [];
      for (const m of rows) {
        const id = String((m && (m.model_name || m.model || m.id)) || "").trim();
        const ratio = m && (m.model_ratio ?? m.ratio);
        const payPerToken = m == null || m.quota_type == null || Number(m.quota_type) === 0;
        if (id && ratio != null && Number.isFinite(Number(ratio)) && Number(ratio) > 0 && payPerToken) {
          perModel.set(id, String(ratio));
        }
      }
      if (perModel.size) source = "newapi-pricing";
    }
  } catch { /* 没有 /api/pricing 是常态 */ }
  if (!perModel.size) {
    try {
      const res = await fetch(`${openai}/sub2api/billing`, { headers, signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        const v = j && (j.effective_rate_multiplier ?? j.resolved_rate_multiplier ?? j.group_rate_multiplier);
        if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) { global = String(v); source = "sub2api-billing"; }
      }
    } catch { /* 非 sub2api 网关 */ }
  }
  return { perModel, global, source };
}

async function probeGet(base, probe, key, authHeader) {
  const t0 = Date.now();
  const headers = key
    ? (authHeader === "x-api-key"
      ? { "X-API-Key": key }
      /* ⛔ MemHub 认的不是 Bearer：X-Tdai-User-Key 带 user_key，X-Tdai-Service-Id 选实例
         （10-23 实测：用 Bearer 一律 401，用这两个头 200） */
      : authHeader === "tdai"
        ? { "X-Tdai-User-Key": key, "X-Tdai-Service-Id": String(probe.serviceId || "default") }
        : { Authorization: `Bearer ${key}` })
    : {};
  try {
    /* ⛔⛔ 10-22 修：`/admin/upstream/test` 传的是**整条 URL**（候选表 `catalogCandidates()` 给的
       `c.url`），而这里原来只认 `base + probe.path` ⇒ `probe.path` 是 undefined ⇒
       URL 变成 `https://wb.ppz123.asia/v1undefined` ⇒ 网关 catch-all 回 **404 HTML（6ms）**，
       「测试连通性」全红，而目录同步（走 collectCatalogRows，用 candidate.url）其实是好的。
       现场症状：面板五条候选全 404，服务端手工 curl 同一地址 401。
       现在两种形态都认：有 `url` 用 url，否则 `base + path`。 */
    const target = String(probe.url || "").trim()
      || (String(base || "").replace(/\/+$/, "") + String(probe.path || ""));
    const init = { headers, signal: AbortSignal.timeout(8000) };
    if (probe.method && String(probe.method).toUpperCase() !== "GET") {
      init.method = String(probe.method).toUpperCase();
      init.headers = Object.assign({}, headers, { "content-type": "application/json" });
      init.body = JSON.stringify(probe.body || {});
    }
    const r = await fetch(target, init);
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
      /* ⛔ 10-22 客户现场：面板报「全 404」，而服务端本机实测同一地址是 401 ⇒
         必须能看到「404 是谁返回的」。带上 Server 头、重定向后的最终 URL、响应体前 120 字：
         nginx / Caddy / Cloudflare 的 404 页面各不相同，一眼就能分清是路径错、还是网络中间层。
         ⛔ 只取前 120 字并脱敏，不进日志。 */
      server: String(r.headers.get("server") || ""),
      finalUrl: String(r.url || ""),
      body: sanitize(text.replace(/\s+/g, " ").trim()).slice(0, 120),
      hint: r.ok ? (count == null && probe.wantList ? "能连通，但没解析出列表（端点存在、格式不同）" : "") : explainProbeStatus(r.status),
    };
  } catch (error) {
    return { name: probe.name, path: probe.path, ok: false, status: 0, ms: Date.now() - t0, count: null, server: "", finalUrl: "", body: "", hint: classifyFetchError(error) };
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
/* 10-20 用户令「自动同步到应用上，别老让我改」：给代理通道一把**永不轮换**的内部钥匙。
   ⛔ 为什么需要：用户令牌（wap_…）明文只在签发时返回一次、库里只存 sha256，
     而网关配置（proxy-config.yaml 的 upstream.apiKey）是快照 ⇒ 用户每重签一次就可能失配，
     表现为 401 invalid-proxy-token。令牌环只能缓解，不能根治。
   ⛔ 这把钥匙固定写在网关配置里，不参与用户令牌轮换 ⇒ 一次配置永久有效。
   ⛔ 不设默认值：未配置时本分支完全不生效（退回原来的纯用户令牌校验）。
   ⛔ 归属账号由 HARNESS_INTERNAL_PROXY_OWNER 指定（默认 admin），决定计费/配额记在谁名下。 */
const INTERNAL_PROXY_KEY = String(process.env.HARNESS_INTERNAL_PROXY_KEY || "").trim();
const INTERNAL_PROXY_OWNER = String(process.env.HARNESS_INTERNAL_PROXY_OWNER || "admin").trim();
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
/** 内部网关请求的真实用户还原（10-20）：
 *  MEMHUB 会透传客户端带来的 `X-Tdai-User-Key`（每个账号一支记忆 key），
 *  用它把「内部服务账号」的模型请求归到真正发起对话的用户，再按该用户的
 *  `userModels` 鉴权、按该用户扣积分。⛔ 只对内部钥匙生效：普通用户令牌
 *  即使带同名头也一律忽略，避免拿别人的记忆 key 越权。找不到映射则保持
 *  内部钥匙的归属账号（旧行为）。 */
function usernameByMemoryKey(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  let found = "";
  for (const [username, slot] of Object.entries(db.integrations || {})) {
    if (!slot || String(slot.memKey || "").trim() !== k) continue;
    /* ⛔ 同一把 memKey 命中多个账号 = 数据异常：宁可判无效，也不能随机挑一个归属。 */
    if (found) return "";
    found = username;
  }
  return found;
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
/** 会话 id 归一化（10-18 安全修复）。
 *  ⛔⛔ 必须过滤：客户端可传 `../../data` 之类，`path.join` 会**把它规范化成越界路径**
 *      ⇒ 登录用户就能读写 sync 根之外的文件。
 *  ⛔ 只允许 [A-Za-z0-9_.-]，并显式拒绝 `/` `\\` `..`；返回空串 = 非法，调用方必须拒绝。 */
function syncId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.includes("/") || s.includes("\\") || s.includes("..")) return "";
  const clean = s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
  if (!clean || clean === ".") return "";
  return clean;
}
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
/** 登录即登记本机（10-18 用户令：「现在直接云账户登录本机，云管理那边是没有新增设备的」）。
 *  ⛔ 与**配对设备**的区别：
 *     · 配对设备 = 有 device token，可独立鉴权（`syncAuth` 第 ① 分支）；
 *     · 登录设备 = 只记录"这台机器登过"，鉴权仍走账号会话（第 ② 分支）。
 *     两者用 `via` 字段区分（`pair` / `login`），UI 打不同标记。
 *  ⛔ 同一台机器恒一条（按 machineId 去重）；若该机器已有配对记录则只 touch，不重复建行。
 *  ⛔ 仍受 DEVICE_LIMIT 限制 —— 超限就不记，并如实返回原因。 */
function registerLoginDevice(username, machineId, name) {
  const mid = String(machineId || "").trim().slice(0, 64);
  if (!mid) return { ok: false, reason: "no-machine-id" };
  /* 同机已有配对记录 ⇒ 只更新 lastSeen（不建第二行） */
  const paired = Object.entries(db.devices).find(([, d]) => d.username === username && d.machineId === mid);
  if (paired) {
    paired[1].lastSeen = Date.now();
    if (name) paired[1].name = String(name).trim().slice(0, 32);
    return { ok: true, linked: true };
  }
  const key = "login:" + crypto.createHash("sha256").update(mid).digest("hex").slice(0, 24);
  const prev = db.devices[key];
  if (prev) {
    if (prev.username !== username) return { ok: false, reason: "machine-bound-to-other-account" };
    prev.lastSeen = Date.now();
    if (name) prev.name = String(name).trim().slice(0, 32);
    return { ok: true, updated: true };
  }
  const count = Object.values(db.devices).filter((d) => d.username === username).length;
  if (count >= DEVICE_LIMIT) return { ok: false, reason: "device-limit", limit: DEVICE_LIMIT };
  db.devices[key] = {
    username,
    name: String(name || "").trim().slice(0, 32) || "登录设备",
    code: "",
    machineId: mid,
    tokenHash: "",
    via: "login",
    claimedAt: Date.now(),
    lastSeen: Date.now(),
  };
  return { ok: true, created: true };
}
function listDevices(username) {
  const out = [];
  for (const [hash, device] of Object.entries(db.devices)) {
    if (device.username !== username) continue;
    out.push({
      id: deviceIdOf(hash),
      name: device.name,
      claimedAt: device.claimedAt,
      lastSeen: device.lastSeen || 0,
      /* ⛔ 10-18：`via` 让前端区分「配对」与「仅登录」；machineId 只给前 8 位用于辨认，不当凭据 */
      via: device.via || "pair",
      machineId: device.machineId ? device.machineId.slice(0, 8) : "",
    });
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
      /* ⛔ 该跟谁比版本（主站比云助手仓、分发包比自己的仓）—— 面板据此显示正确的"最新版" */
      updateRepo: UPDATE_REPO,
      updateRepoUrl: UPDATE_REPO_URL,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
    });
  }
  /* ── 站点图标（10-18 用户令「做成自定义图标，管理员可以上传改这个图标，默认现在的可以」）──
     ⛔ 设计取舍：
        · 存储放 `<data 目录>/branding/favicon.<ext>` —— 与 data.json 同级，
          ⛔ 不放 web 目录：那样会被 selfupdate 的覆盖流程当成"自己的文件"管起来。
        · `GET /api/favicon` 是**公开**端点：有自定义就发自定义，否则发内置默认
          （`HARNESS_WEB_DIR/favicon-32.png`）⇒ 前端只需一个 link，永远有内容、不用 onerror 兜底。
        · `POST /admin/favicon` 收 **base64**（不解析 multipart，省一个依赖）；
          校验类型白名单 + ≤512KB，文件名固定 `favicon.<ext>`，⛔ 绝不按客户端文件名落盘。
     · `DELETE /admin/favicon` 恢复默认。 */
  if (p === "/api/favicon" && req.method === "GET") {
    const dir = path.join(path.dirname(DATA_FILE), "branding");
    const custom = ["png", "jpeg", "svg"].map((e) => path.join(dir, "favicon." + e)).find((f) => { try { return fs.existsSync(f); } catch { return false; } });
    const builtin = path.join(String(process.env.HARNESS_WEB_DIR || "/var/www/codex-harness-cloud"), "favicon-32.png");
    const file = custom || builtin;
    try {
      const buf = fs.readFileSync(file);
      const mime = file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".jpeg") ? "image/jpeg" : "image/png";
      /* 自定义图标缓存 5 分钟便于管理员改完即时生效；默认图标可长缓存 */
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": custom ? "public, max-age=300" : "public, max-age=86400" });
      res.end(buf);
    } catch {
      send(404, { ok: false, error: "favicon-missing" });
    }
    return;
  }
  if (p === "/admin/favicon" && req.method === "POST") {
    if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
    const body = await readBodyLarge(2 * 1024 * 1024);
    const data = String((body && body.data) || "");
    const m = /^data:image\/(png|jpeg|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!m) return send(400, { ok: false, error: "格式不对：请上传 PNG/JPEG/SVG 的 base64 data URL" });
    const ext = m[1] === "svg+xml" ? "svg" : m[1];
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length) return send(400, { ok: false, error: "内容为空" });
    if (buf.length > 512 * 1024) return send(400, { ok: false, error: "图标过大（上限 512KB）" });
    /* ⛔ 固定文件名 + 白名单扩展名：绝不使用客户端给的文件名（路径穿越） */
    const dir = path.join(path.dirname(DATA_FILE), "branding");
    fs.mkdirSync(dir, { recursive: true });
    for (const e of ["png", "jpeg", "svg"]) { try { fs.rmSync(path.join(dir, "favicon." + e), { force: true }); } catch { /* 忽略 */ } }
    fs.writeFileSync(path.join(dir, "favicon." + ext), buf, { mode: 0o644 });
    console.log(`[branding] ${me.username} 上传站点图标（${ext}, ${buf.length} B）`);
    return send(200, { ok: true, ext, bytes: buf.length });
  }
  if (p === "/admin/favicon" && req.method === "DELETE") {
    if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
    const dir = path.join(path.dirname(DATA_FILE), "branding");
    for (const e of ["png", "jpeg", "svg"]) { try { fs.rmSync(path.join(dir, "favicon." + e), { force: true }); } catch { /* 忽略 */ } }
    console.log(`[branding] ${me.username} 恢复默认站点图标`);
    return send(200, { ok: true });
  }
  /* ── 检查更新（10-18 用户令「加上国内镜像更新」）──────────────────────────
     ⛔ 为什么不在浏览器里查 GitHub：
        ① 匿名 API 限 **60 次/小时/IP**，超了就是 **403** —— 很容易被误读成"被墙"
           （实测：面板点「检查更新」直接 403，提示语也写错了）；
        ② 国内浏览器直连 github.com / api.github.com 经常超时。
     ⇒ 由**服务端**依次试「直连 + 国内镜像」的 **raw 文件**：raw 不计 API 配额，
        镜像只做透传。⛔ 只读一个 VERSION 文本，不拉代码、不执行任何东西。 */
  /* ── 应用更新并重启（10-18 用户令「加自动更新重启，方便用户那边自动更新」）──
     ⛔ 不自己 spawn 新进程（会出现两个实例抢 data.json）：调 selfupdate.sh 覆盖文件后
       `process.exit(0)`，由 systemd 的 `Restart=always` 拉起。这是唯一安全的自我更新方式。
     ⛔ 先回响应再退出，否则客户端只看到"连接被重置"。⛔ 仅 admin。 */
  /* 更新进度（前端轮询）：只回最近一次 apply 的状态，⛔ 不暴露脚本全文 */
  /* ── 应用连接地址（10-18 用户令「用户管理里加应用连接的 api 地址 + 复制，部署完自动生成」）──
     ⛔ **不硬编码域名**：从当前请求的 host / x-forwarded-proto 推出来 —— 换域名、上 HTTPS、
       反代前缀改了，这里都自动跟着变，不需要改代码重新部署。 */
  if (p === "/api/app-endpoint" && req.method === "GET") {
    /* ⛔ 这一段在 `const me = sessionUser(req)` **之前**（公开路由区）——
       此处引用 me 会 ReferenceError 并把进程打挂（实测：每次请求 502 一次）。
       地址本身不是秘密（登录页域名就能看出来），不做 admin 校验。 */
    return send(200, { ok: true, apiBase: publicBaseOf(req), host: String(req.headers["x-forwarded-host"] || req.headers.host || "") });
  }

  if (p === "/api/updates/progress" && req.method === "GET") {
    const g = db.updateProgress || null;
    return send(200, { ok: true, progress: g ? { pct: g.pct || 0, label: g.label || "", done: Boolean(g.done), at: g.at || 0, error: g.error || "" } : null, version: APP_VERSION });
  }

  if (p === "/api/updates/apply" && req.method === "POST") {
    if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
    const script = [path.join(__dirname, "selfupdate.sh"), path.join(__dirname, "..", "selfupdate.sh")].find((f) => { try { return fs.existsSync(f); } catch { return false; } });
    if (!script) return send(400, { ok: false, error: "找不到 selfupdate.sh —— 这个部署方式不支持应用内更新" });
    /* ⛔ 用 spawn 而不是 execFile：要**流式**拿每一行输出，才能把进度推给前端。
       阶段映射（不精确到字节，但足以让用户知道在干什么）：
         采用最高版本 → 10% · 每个 ✓ 文件 → 递增至 80% · VERSION → 92% · 即将重启 → 100% */
    const { spawn } = require("node:child_process");
    db.updateProgress = { pct: 5, label: "准备中…", at: Date.now(), done: false };
    persist();
    const child = spawn("bash", [script, "--no-restart"], { cwd: path.dirname(script) });
    let done = 0, total = 8, tail = [];
    const bump = (label, pct) => { db.updateProgress = { pct, label, at: Date.now(), done: false }; };
    const onLine = (line) => {
      if (!line.trim()) return;
      tail.push(line); if (tail.length > 14) tail.shift();
      if (/采用最高版本/.test(line)) bump("已获取最新版本，开始下载…", 10);
      else if (/✓/.test(line)) { done += 1; bump(`下载并校验 ${done}/${total}…`, Math.min(80, 10 + Math.round((done / total) * 70))); }
      else if (/VERSION →/.test(line)) bump("写入完成，准备重启…", 92);
    };
    let buf = "";
    child.stdout.on("data", (d) => { buf += d.toString(); const parts = buf.split("\n"); buf = parts.pop(); parts.forEach(onLine); });
    child.stderr.on("data", (d) => { buf += d.toString(); });
    child.on("close", (code) => {
      if (buf) onLine(buf);
      if (code !== 0) {
        db.updateProgress = { pct: 0, label: "更新失败", at: Date.now(), done: true, error: tail.slice(-6).join("\n") };
        persist();
        return send(500, { ok: false, error: `selfupdate 退出码 ${code}`, log: tail.join("\n") });
      }
      db.updateProgress = { pct: 100, label: "更新完成，正在重启…", at: Date.now(), done: true };
      persist();
      send(200, { ok: true, log: tail.join("\n"), restarting: true });
      console.log(`[update] ${me.username} 触发应用更新，即将退出交给 systemd`);
      setTimeout(() => process.exit(0), 1200);
    });
    return;
  }

  if (p === "/api/updates" && req.method === "GET") {
    const rawUrl = UPDATE_REPO_URL.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/main/" + UPDATE_VERSION_PATH;
    const probeOne = async (m) => {
      const t0 = Date.now();
      try {
        /* ⛔ 带时间戳 query：镜像/CDN 会缓存 raw 文件，不加更容易读到上一版 */
        const r = await fetch(m.prefix + rawUrl + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000), headers: { "Cache-Control": "no-cache" } });
        const text = r.ok ? (await r.text()).trim() : "";
        /* ⛔ 清单是 JSON（取 `version`）；分发包的 VERSION 是纯文本 ⇒ 先按 JSON 试，失败回落文本 */
        const latest = (() => {
          if (!text) return "";
          try {
            const j = JSON.parse(text);
            if (j && j.version) return String(j.version).trim().replace(/^v/, "");
          } catch { /* 不是 JSON：按纯文本处理 */ }
          return ((text.match(/^v?\d+\.\d+\.\d+/) || [])[0] || "").replace(/^v/, "");
        })();
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
      /* ⛔⛔ 10-19（清单 3）：用户名**大小写不敏感**去重 —— 服务端的查找是 `===`，
         放行 `PPZ11` 会产生与 `pzm11` 并列的第二个账号 ⇒「订阅在 A、应用登 B」的错位
         （实测：同一个人被分成两个账号，重签落在另一个账号上、本机 key 永不更新）。 */
      if (db.users.some((u) => String(u.username).toLowerCase() === username.toLowerCase())) {
        return send(409, { ok: false, error: "用户名已被占用（不区分大小写，请直接用原账号登录）" });
      }
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

      /* 10-19 用户要求：注册后**自动**建好该账号的独立知识库与记忆空间。
         ⛔ 用 provisionFor（fire-and-forget + 幂等 + 失败只记日志），绝不 await ——
            远端建库 1~3 秒，等它就是让「注册」按钮转圈。
         ⛔ 所有消费入口（/integrations、/kb/*）仍会再调 ensure*，这里只是提前预热。 */
      provisionFor(username, "knowledge");
      provisionFor(username, "memory");      return send(200, { ok: true, token: issueSession(username), account: publicView(user), points: { balance: pointsOf(username).balance, granted: SIGNUP_GRANT } });
    }

    /* 登录 */
    if (p === "/login" && req.method === "POST") {
      if (!rateLimit(`login-ip:${ip}`, 10, 5 * 60_000)) return send(429, { ok: false, error: "尝试过多，请几分钟后再来" });
      const body = await readBody();
      const username = String(body.username || "").trim();
      /* ⛔ 10-19（清单 3）：精确匹配优先；没有则**唯一**的大小写不敏感匹配
         （老数据里可能已有 `pzm11` / `PPZ11` 两个变体 —— 有歧义时不做猜测，仍按"用户名或密码不对"拒绝）。 */
      const user = db.users.find((u) => u.username === username)
        || (() => {
          const lower = username.toLowerCase();
          const hits = db.users.filter((u) => String(u.username).toLowerCase() === lower);
          return hits.length === 1 ? hits[0] : null;
        })();
      if (!user) return send(401, { ok: false, error: "用户名或密码不对" });
      if (user.disabled) return send(403, { ok: false, error: "该账号已被停用，联系管理员" });
      if (Date.now() < user.lockUntil) return send(429, { ok: false, error: "该账号已被临时锁定，稍后再试" });
      if (!rateLimit(`login-u:${username}`, 5, 15 * 60_000)) {
        user.lockUntil = Date.now() + 15 * 60_000; persist();
        return send(429, { ok: false, error: "失败次数过多，账号锁定 15 分钟" });
      }
      const accountName = user.username;   // ⛔ 大小写回退命中时以存储名为准（session/设备/积分都按它查）
      if (!verifyPassword(user, body.password)) {
        user.failCount = (user.failCount || 0) + 1; persist();
        return send(401, { ok: false, error: "用户名或密码不对" });
      }
      user.failCount = 0; user.lastLogin = Date.now(); persist();
      /* 10-18 设备管理：登录即登记本机（否则云端「已配对设备」永远是 0）。
         ⛔ 登记失败不阻断登录 —— 设备上限/缺 machineId 都不该让人登不进来。 */
      const reg = (() => { try { return registerLoginDevice(accountName, body.machineId, body.machineName); } catch { return { ok: false, reason: "exception" }; } })();
      if (reg.ok) persist();
      return send(200, {
        ok: true,
        token: issueSession(username),
        account: publicView(user),
        server: { baseUrl: publicBaseOf(req) },
        device: { registered: Boolean(reg.ok), created: Boolean(reg.created), reason: reg.ok ? "" : reg.reason },
      });
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
    async function collectCatalogRows(base, authKey) {
      const headers = authKey ? { Authorization: `Bearer ${authKey}` } : {};
      const tried = [];
      let rows = null;
      let source = "catalog";
      let payload = null;
      for (const candidate of catalogCandidates(base)) {
        try {
          const res = await fetch(candidate.url, { headers });
          if (!res.ok) { tried.push(`${candidate.name} HTTP ${res.status}`); continue; }
          const body = await res.json().catch(() => null);
          const got = modelsFromPayload(body);
          if (got && got.length) { payload = body; rows = got; source = /v1\/models|\/models$/i.test(candidate.url) ? "openai" : "catalog"; break; }
          tried.push(`${candidate.name} 返回的不是模型列表${got ? "（空列表）" : ""}`);
        } catch (error) {
          tried.push(`${candidate.name} ${classifyFetchError(error)}`);
        }
      }
      if (rows && source === "openai") {
        try {
          const { openai } = splitUpstreamBase(base);
          const claudeRows = await fetchModelsByProtocol(`${openai}/models`, authKey, "anthropic");
          if (claudeRows && claudeRows.length) {
            const have = new Set(rows.map((m) => String((m && m.id) || "").trim()));
            for (const m of claudeRows) {
              const id = String((m && m.id) || "").trim();
              if (id && !have.has(id)) { rows.push(m); have.add(id); }
            }
          }
        } catch { /* 不支持 Anthropic 头就跳过 */ }
      }
      return { rows, source, payload, tried };
    }

    async function pullModelCatalog(force = false) {
      /* ⛔ 10-22 用户：「我都换了，没有自动跟随更新」——缓存只按时间算：换上游地址后 30 分钟内
         仍命中旧缓存 ⇒ 永远不同步新地址。fresh 必须同时要求「目录来自当前这个上游」。 */
      const sameBase = (db.modelCatalog.base || "") === currentCatalogBase();
      const fresh = sameBase && Date.now() - Number(db.modelCatalog.syncedAt || 0) < MODEL_SYNC_TTL_MS;
      if (!force && fresh && Array.isArray(db.modelCatalog.list) && db.modelCatalog.list.length) return { ok: true, cached: true };
      /* ⛔ 用 currentCatalogBase()（管理员可配），**不是** WBM_BASE 常量 ——
         否则"改了上游地址、点同步却还是拉旧地址"（配了没用，10-18 实测就是这个坑）。 */
      const catalogBase = currentCatalogBase();
      if (!catalogBase) return { ok: false, error: "catalog-not-configured", message: "还没配置上游地址（或环境变量里没有）" };
      try {
        /* ⛔ 10-18：目录来源**不止 WBM**。用户实测：上游是 OpenAI 兼容网关 ——
           `/api/model-catalog` 返 **401**、而 `/v1/models` 有 50 个模型 ⇒ 必须能回落。
           ⛔ 两源统一映射成同一份 list；OpenAI 源**没有倍率** ⇒ 打 `creditsMissing` 标记，
              由面板提示「未设倍率（当前免费）」。⛔ 绝不猜一个默认倍率 —— 猜错就是多扣钱。 */
        const authKey = WBM_TOKEN || currentGatewayKey();
        /* ⛔ 10-22 修三个实测坑（用户贴图：填 `https://cn.pptoken.cc` 明明 /v1/models 有 12 个模型，
           面板仍报「同步失败：wbm-unreachable」）：
           ① 地址里带 `/v1` 时，旧代码拼成 `/v1/api/model-catalog`、`/v1/v1/models` ⇒ 打到 catch-all
              拿回 200 HTML，`.json()` 抛异常；
           ② 旧代码把「200 但 body 不是 JSON」当成致命错误直接进 catch ⇒ **连 OpenAI 回落的门都没进**；
           ③ 只认 `data` / `models` 两种形状。
           现在：先按**根**拉管理目录，失败（含解析失败、抛异常）再按 `/v1` 拉 OpenAI 列表；
           形状统一交给 modelsFromPayload；两条都拿不到才报错，并把每条的原因带回面板。 */
        /* ⛔ 10-22 用户：「适配性强，不要写死，只要地址和密钥填了就要识别出来」。
           候选表与「测试连通性」共用（catalogCandidates），按顺序试、谁先给出列表用谁：
           地址带不带 /v1 都覆盖；以后加新协议只改那张表，这里不动。 */
        const { rows, source, payload: data, tried } = await collectCatalogRows(catalogBase, authKey);
        if (!rows) {
          /* ★ 10-22 用户：「直接清空，不要留着」——**换了上游地址**且新地址给不出列表时，
             旧目录已经不代表任何东西（还挂着旧倍率）⇒ 直接清掉，不留在界面上误导。
             ⛔ 只有「目录来自的地址 ≠ 当前地址」才清；同一地址的偶发失败仍保留（不因一次网络抖动丢数据）。 */
          const changedBase = Boolean(db.modelCatalog.base) && db.modelCatalog.base !== catalogBase;
          if (changedBase) {
            db.modelCatalog = { syncedAt: 0, list: [], available: [], base: "", rateSource: "", catalogSource: "" };
            persist();
          }
          lastCatalogError = { error: "catalog-unreachable", base: catalogBase, message: sanitize(`上游 ${catalogBase} 没给出模型列表：${tried.join(" · ")}`) };
          return { ok: false, cleared: changedBase, ...lastCatalogError };
        }
        /* 上游倍率（逐模型 pricing / 账号级 billing），拿不到就留空。 */
        const rates = await readUpstreamRates(catalogBase, authKey).catch(() => ({ perModel: new Map(), global: null, source: "" }));
        const rateFor = (id) => rates.perModel.get(id) || rates.global || "";
        const list = rows.map((m) => {
          /* OpenAI 形状只有 id / object / created / owned_by：其余字段留空并标「缺倍率」 */
          if (source === "openai") {
            const oaId = String(m.id || "").trim();
            const oaRate = String((m && (m.credits ?? m.credit ?? m.rate ?? m.ratio)) || "").trim() || rateFor(oaId);
            return {
              /* ⛔ name = **映射后的展示名**，id 仍是上游 id（调用要用它）；upstreamName 留底便于回退。 */
              id: oaId, name: oaId, upstreamName: oaId,
              description: oaRate ? "OpenAI / Claude 兼容目录（倍率取自上游 pricing / billing）" : "OpenAI 兼容目录（上游未提供倍率与规格）",
              credits: oaRate, tags: [], series: "",
              contextLength: null, maxOutputTokens: null,
              supportsImages: false, supportsReasoning: false,
              creditsMissing: !oaRate,
            };
          }
          const cid = String(m.id || "").trim();
          const upstreamName = String(m.name || m.id || "").trim();
          return {
            id: cid,
            name: upstreamName,
            upstreamName,
            description: String(m.description || "").slice(0, 200),
            /* WBM 目录自带倍率；个别网关叫 credit / rate / ratio，统一兜住，最后再落上游 pricing/billing。 */
            credits: String(m.credits ?? m.credit ?? m.rate ?? m.ratio ?? "").trim() || rateFor(cid),
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
          realm: source === "openai" ? "openai" : String((data && data.realm) || "cn"),
          /* ⛔ 记下目录来源：面板据此提示「上游没给倍率，需手动填」（openai 源一定缺倍率） */
          source: source === "openai" ? "openai-compat" : String((data && (data.source_label || data.source)) || "catalog"),
          catalogSource: source,
          rateSource: rates.source || "",
          /* 10-22 用户：「我都换了，没有自动跟随更新」——记下这份目录是**哪个上游**拉的，
             换地址后同步失败仍会保留旧目录，但面板必须能指出「这是旧上游的」。 */
          base: catalogBase,
          list,
          ...(prevAvail ? { available: prevAvail.filter((x) => ids.has(x)) } : {}),
        };
        persist();
        lastCatalogError = null;
        return { ok: true, count: list.length, syncedAt: db.modelCatalog.syncedAt };
      } catch (error) {
        /* ⛔ 出错信息可能含 URL/凭据（fetch 的 TypeError 会把地址带进来）⇒ 必须脱敏 */
        lastCatalogError = { error: "catalog-unreachable", message: sanitize(error && error.message) };
        return { ok: false, ...lastCatalogError };
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
    /* ── 会话同步总闸（10-18 用户令「加一个管理员可以开关功能，关闭后用户就不能同步会话」）──
       ⛔ 语义：`db.features.sessionSync === false` 才算关闭 —— **默认开**，不改变既有行为。
       ⛔ 关闭后 `/sync/*` 五个接口一律 403，并回明确的 `session-sync-disabled`（客户端据此显示"已关闭"，
          而不是当成网络故障去重试）。
       ⛔ 只拦"同步"，**不拦登录/积分/模型**：关了同步用户照样能用模型。 */
    if (p.startsWith("/sync/") && db.features && db.features.sessionSync === false) {
      return send(403, { ok: false, error: "session-sync-disabled", message: "管理员已关闭云端会话同步" });
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
      const id = syncId(url.searchParams.get("id"));
      if (!id) return send(400, { ok: false, error: "bad-id" });
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
      /* ⛔ 10-18（用户拍板方案 A）：device token 由「必需」改为「可选」。
         依据：同步存储按 `syncUserDir(who.username)` **按用户隔离**，device 只用于标记
         "哪台机器传的"，**不是隔离凭据** ⇒ 桌面版用云账号 token 直接上传是安全的。
         ⛔ 仍然要求已登录：`who` 来自 `syncAuth()`，匿名请求在这一步之前就被拦掉了。
         ⛔ 桌面版没有配对流程（`readDeviceToken` 只在云助手的 headless 里），
            这条 403 会让桌面版的「上传会话」永远失败 —— 这是放开它的直接原因。 */
      const body = await readBodyLarge();
      const incoming = Array.isArray(body && body.sessions) ? body.sessions : [];
      const index = readSyncIndex(who.username);
      let used = syncUsageBytes(who.username);
      const results = [];
      for (const item of incoming) {
        const id = syncId(item && item.id);
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
      const ids = (Array.isArray(body && body.ids) ? body.ids : []).map(syncId).filter(Boolean);
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
          /* ⛔ 10-19（清单 4）：只给**前缀**（不含密钥值）⇒ 客户端能发现「本机缓存已被轮换」，
             不必等一次 401 才知道。`proxyTokenAt` 用于界面显示签发时间。 */
          proxyTokenPrefix: String(db.proxyTokens[who.username]?.prefix || ""),
          proxyTokenAt: Number(db.proxyTokens[who.username]?.createdAt || 0),
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
      /* 10-20：内部网关钥匙放行（不参与用户令牌轮换，见常量处说明）。 */
      const internal = Boolean(INTERNAL_PROXY_KEY && presented === INTERNAL_PROXY_KEY);
      const hit = internal
        ? { username: INTERNAL_PROXY_OWNER, row: { username: INTERNAL_PROXY_OWNER, ips: [] } }
        : proxyUserByToken(presented);
      if (!hit) return send(401, { ok: false, error: "invalid-proxy-token" });
      /* 10-20 根治「勾了 4 个只有 1 个能用」：内部网关的真实调用人不是 PPZ11。
         ⛔⛔ 身份必须**两证一致**：MEMHUB 会把客户端自带的 X-Tdai-User-Key 原样透传，
            单靠这个头 = 客户端自报身份（实测：拿 A 的钥匙、塞 B 的 memKey，服务端按 B 处理）。
            现在要求同时带本机账号的代理令牌（X-Harness-Proxy-Token），两者映射到同一用户才放行；
            缺令牌时**不采信 memKey**（回退内部账号），避免伪造头越权/串号。 */
      const claimedMemKey = internal ? String(req.headers["x-tdai-user-key"] || "").trim() : "";
      const claimedToken = internal ? String(req.headers["x-harness-proxy-token"] || "").trim() : "";
      const hasIdentity = Boolean(claimedToken || claimedMemKey);
      const memUser = internal ? usernameByMemoryKey(claimedMemKey) : "";
      const tokenHit = claimedToken ? proxyUserByToken(claimedToken) : null;
      if (internal && hasIdentity) {
        /* ⛔ 双证必须**同时存在且指向同一用户**：只有其中一枚 ⇒ 不完整，直接拒。
           这是防「偷到代理令牌/记忆 key 任意一枚就能冒用」的第二道锁。 */
        if (!claimedToken || !claimedMemKey) {
          return send(403, { ok: false, error: "identity-incomplete", message: "云端身份不完整（缺少令牌或记忆 key），请重新登录并同步模型" });
        }
        if (!tokenHit) {
          return send(401, { ok: false, error: "invalid-identity-token", message: "云端身份令牌无效，请重新同步模型后再试" });
        }
        if (!memUser) {
          return send(403, { ok: false, error: "identity-unknown-memkey", message: "云端记忆身份无法识别，请重新登录并同步模型" });
        }
        if (tokenHit.username !== memUser) {
          console.log(`[proxy] ⛔ 身份不一致：proxyToken=${tokenHit.username} memKey=${memUser}`);
          return send(403, { ok: false, error: "identity-mismatch", message: "云端身份校验不一致，已拒绝（请重新登录并同步模型）" });
        }
      }
      const effectiveUsername = internal && hasIdentity ? tokenHit.username : hit.username;
      if (internal && effectiveUsername !== hit.username) {
        console.log(`[proxy] 内部网关请求归属 ${hit.username} → ${effectiveUsername}（token+memKey 已校验）`);
      } else if (internal && !hasIdentity) {
        console.log(`[proxy] ⚠ 内部网关未带用户身份 ⇒ 回退 ${hit.username}（老客户端兼容；不涉及任何真实用户）`);
      }
      const owner = db.users.find((u) => u.username === effectiveUsername);
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
      const allowed = new Set(Array.isArray(db.userModels[effectiveUsername]) ? db.userModels[effectiveUsername] : []);
      if (p.endsWith("models")) {
        // 模型清单也按勾选过滤（客户端因此只看得到自己启用的）
        const upstreamList = await (async () => {
          try {
            const r = await fetch(upstreamUrl("models"), { headers: { Authorization: `Bearer ${currentGatewayKey()}` } });
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
      const myBalance = pointsOf(effectiveUsername).balance;
      if (myBalance <= 0) {
        return send(402, { ok: false, error: "insufficient-points", balance: myBalance, message: "积分为 0，已暂停调用 —— 请联系管理员加分或改用其它供应商" });
      }
      let wantedModel = "";
      try { wantedModel = String((JSON.parse(bodyBuf.toString("utf8")) || {}).model || ""); } catch { /* 解析不了就交给上游报错 */ }
      if (wantedModel && !allowed.has(wantedModel)) {
        return send(403, { ok: false, error: "model-not-enabled", message: "该模型未在「限时福利」里启用 —— 请在云端管理的模型列表里勾选后重试" });
      }
      /* 转发：只替换 Authorization，其余原样（模型、参数、流式标志） */
      const target = upstreamUrl(p.endsWith("models") ? "models" : "chat/completions");
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
          /* ── 逆向调试开关（默认关）──────────────────────────────────────────
             ⛔ 目的：确认上游回执里**到底有没有"缓存 token"字段**。
               没有它，上游的精确计费公式**不可逆** —— 因为同一个 token 数它能扣 0.55 也能扣 9.33，
               差值只能来自"缓存命中比例"，而这个比例我们拿不到。
             ⛔ 只打 `usage` 对象（token 数/credit），**不打对话内容、不打提示词**。
             开启方式：`HARNESS_CAPTURE_USAGE=1` 写进 systemd Environment 或 config.env 后重启。 */
          if (String(process.env.HARNESS_CAPTURE_USAGE || "") === "1") {
            const um = /"usage"\s*:\s*(\{[\s\S]{0,2000}?\})\s*[,}]/.exec(text);
            if (um) console.log(`[usage-raw] ${wantedModel} ${um[1].replace(/\s+/g, " ").slice(0, 1200)}`);
            else console.log(`[usage-raw] ${wantedModel} 回执里没有 usage 对象（非 JSON 流？）`);
          }
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
          /* ⛔⛔ 口径变更史（**看这段再动手**）：
             · 10-17 21:5x 用户定案「就按用户管理里的倍率扣，不用管上游」⇒ 用 tokens/1000×倍率。
             · **10-18 17:1x 用户推翻**：「上游消耗才一点，我们消耗 20 多积分，差得太大了」
               ⇒ 改回**以上游 `credit` 为基准**（用户在选择里明确选「以上游 credit 为准（对得上账）」）。
               实测差距：hy4-preview 73,655 tokens ⇒ 上游 1.37 / 旧算法 21.36（差 15 倍）；
               根因是上游按**缓存命中**折价（截图显示缓存 92%），而我们的回执里**没有 cached_tokens**
               ⇒ 我们连"扣缓存"都做不到，只能直接采信上游的 credit。
             · 闲时倍率仍生效：按**比值**折算 `credit × (闲时倍率 / 高峰倍率)`，
               这样"闲时调低多少"照样管用，但基数不偏离上游。
             ⛔ 拿不到上游 credit（null/0）才回落到 `tokens/1000 × 倍率`，并在日志里写清用的是哪条路径。 */
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
            /* ⛔⛔ 10-18 修计价基准（用户实测差距 15 倍）：
               上游 hy4-preview 73,655 tokens **实付 1.37**，而我们 tokens/1000×0.29 = **21.36**。
               原因：上游 `credit` 是它服务端自己算的 —— 单价因模型而异、还含它自己的折扣/缓存口径，
               我们**复现不了**（同 token 不同请求上游能给 0.55 ~ 9.33）。
               ⇒ **基准 = 上游 credit（>0 时）**，拿不到才回落到 `tokens/1000 × 倍率`。
               ⇒ 闲时倍率按**比值**折算：`credit × (闲时倍率 / 高峰倍率)` ——
                  这样"闲时倍率调低多少"仍然生效，但基数不会偏离上游。 */
            const upCredit = (credit !== null && Number.isFinite(credit) && credit > 0) ? credit : null;
            const ratio = normalRate > 0 ? rate / normalRate : 1;
            /* ⛔⛔ 10-18 17:1x 用户确认的**双轨**语义（原话：
               「如果我修改倍率，就以我修改的倍率为准对吧，如果没修改就以上游积分消耗为准是吧」）：
               · **改过**该模型倍率（`creditsLocked === true`）⇒ 按**你设的倍率**算：
                 `tokens/1000 × 倍率`（闲时倍率直接替换倍率，同既有语义）。
               · **没改过** ⇒ 以上游 `credit` 为准（× 闲时比值）。
               · 上游没给 credit ⇒ 回落本地倍率（日志写明）。
               ⛔ `creditsLocked` 就是"管理员是否显式改过"的标记 —— 改过即钉住，
                  同步目录也不会覆盖（这正是它存在的意义，拿它当判据最准）。 */
            const locked = Boolean(item && item.creditsLocked === true);
            if (locked && totalTokens > 0 && Number.isFinite(rate) && rate > 0) {
              credit = Math.round((totalTokens / 1000) * rate * 100) / 100;
              console.log(`[points] 计价：${wantedModel} ${totalTokens} tokens × ${rate} = ${credit}（你改过倍率 ⇒ 按你的倍率）`);
            } else if (upCredit !== null) {
              credit = Math.round(upCredit * ratio * 100) / 100;
              const offNote = peak
                ? `（闲时${peak.label ? `「${peak.label}」` : ""}，按倍率比 ${ratio.toFixed(3)} 折算）`
                : "";
              console.log(`[points] 计价：${wantedModel} 上游 credit ${upCredit}${offNote} → 扣 ${credit}（没改倍率 ⇒ 基准=上游）`);
            } else if (totalTokens > 0 && Number.isFinite(rate) && rate > 0) {
              credit = Math.round((totalTokens / 1000) * rate * 100) / 100;
              console.log(`[points] 计价：${wantedModel} ${totalTokens} tokens × ${rate} = ${credit}（上游没给 credit，回落本地倍率）`);
            } else if (!(credit > 0)) {
              credit = 0;
            }
          } catch { /* 计价失败则维持原判 */ }
          if (credit !== null && Number.isFinite(credit) && credit >= 0) {
            const ref = `call:${crypto.randomBytes(8).toString("hex")}`;
            const label = wantedModel || "模型调用";
            const r = credit > 0
              ? addPoints(effectiveUsername, -credit, "consume", ref, `限时福利 · ${label} 消耗 ${credit}`)
              : addUsageOnly(effectiveUsername, "consume", ref, `限时福利 · ${label}（免费模型，未扣积分）`);
            /* ⛔ 10-18 修：`addPoints` / `addUsageOnly` **只改内存不落盘**（它们的实现里没有 persist），
               原来这里也没有 ⇒ 这条消耗流水要等**下一次**请求在鉴权处顺带 persist 才写进 data.json；
               若期间服务重启/崩溃，这次消耗就**永久丢失**（用户只调一次就重启 ⇒ 白送）。
               消耗是账本，必须当场落盘。 */
            if (r.changed) { persist(); console.log(`[points] ${effectiveUsername} ${credit > 0 ? `消耗 ${credit}` : "免费调用"}（余额 ${r.balance}）`); }
          }
        } catch { /* 记分失败不影响调用本身 */ }
      } catch (error) {
        send(502, { ok: false, error: "upstream-unreachable", message: sanitize(error && error.message) });
      }
      return;
    }
    if (p === "/admin/models/clear" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      if (!body || body.confirm !== true) return send(400, { ok: false, error: "需要确认（confirm: true）" });
      const before = Array.isArray(db.modelCatalog.list) ? db.modelCatalog.list.length : 0;
      /* ⛔ 10-22：清空后必须**暂停自动同步** —— 否则面板一刷新就按当前上游重新拉满，
         用户看到的就是「点了清空没反应」。只有手动「重新同步目录」/保存上游才解除。 */
      db.modelCatalog = { syncedAt: 0, list: [], available: [], base: "", rateSource: "", catalogSource: "", autoSyncDisabled: true };
      persist();
      console.log(`[catalog] ${me.username} 清空模型目录（原有 ${before} 个，自动同步已暂停）`);
      return send(200, { ok: true, cleared: before });
    }
    /* 管理员：立刻重新拉取模型目录（force 绕过缓存） */
    /* 管理员：立刻重新拉取模型目录（force 绕过缓存） */
    if (p === "/admin/models/sync" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const pulled = await pullModelCatalog(true);
      return send(pulled.ok ? 200 : 502, { ok: pulled.ok, ...pulled, total: (db.modelCatalog.list || []).length });
    }
    /* ── 10-15 管理员模型管理：目录 + 每用户可用模型 + 倍率 ─────────────── */
    if (p === "/admin/models" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      /* 10-22 用户问「模型目录不是自动新增吗」：原来只有客户端 /models 与手动按钮会拉目录，
         管理员打开本页看到的可能是几小时前的快照 ⇒ 这里按 TTL（默认 30 分钟）自动补一次。 */
      /* 10-22 用户：「自动刷新缓存」——面板带 ?refresh=1 时强制重拉（绕 30 分钟 TTL），
         用来「打开页面就刷新 / 每两分钟自动刷一次」；不带参数仍走 TTL，避免客户端请求打爆上游。 */
      const forceRefresh = /(?:^|&)refresh=1(?:&|$)/.test(String(req.url || "").split("?")[1] || "");
      /* 用户手动清空过 ⇒ 不自动拉（否则立刻被填回来）；手动刷新/保存上游不受限制。 */
      const held = Boolean(db.modelCatalog.autoSyncDisabled) && !forceRefresh;
      const autoPulled = held ? null : await pullModelCatalog(forceRefresh).catch(() => null);
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
        autoSynced: Boolean(autoPulled && autoPulled.ok),
        syncError: lastCatalogError ? lastCatalogError.error : "",
        syncMessage: lastCatalogError ? lastCatalogError.message : "",
        /* ⛔ 必须是 currentCatalogBase()（本作用域没有 catalogBase —— 那是 pullModelCatalog 的局部量）；
           面板据此显示「到底在从哪个地址拉目录」，不然报错只说「没给出列表」，排查无从下手。 */
        catalogBase: currentCatalogBase(),
        rateSource: db.modelCatalog.rateSource || "",

        catalogFrom: db.modelCatalog.base || "",
        autoSyncPaused: Boolean(db.modelCatalog.autoSyncDisabled),
        /* ⛔ 目录来源 ≠ 当前上游 ⇒ 面板显示「已过期」，而不是静默保留旧目录让用户以为没生效。 */
        stale: Boolean(db.modelCatalog.base && db.modelCatalog.base !== currentCatalogBase()),
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
    if (p === "/admin/models/batch" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const ids = Array.isArray(body && body.ids) ? body.ids.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!ids.length) return send(400, { ok: false, error: "没有选择模型" });
      const wanted = new Set(ids);
      const targets = (db.modelCatalog.list || []).filter((m) => wanted.has(m.id));
      if (!targets.length) return send(404, { ok: false, error: "选中的模型不在目录里（先同步目录）" });
      /* 批量删除（10-22 用户：「还有批量删除功能」）——从目录里移除选中模型；
         ⛔ 必须显式 confirm；同时把它们从「对用户开放」里剔除，避免留下幽灵 id。 */
      if (body && body.delete === true) {
        if (body.confirm !== true) return send(400, { ok: false, error: "删除需要确认（confirm: true）" });
        const beforeCount = (db.modelCatalog.list || []).length;
        db.modelCatalog.list = (db.modelCatalog.list || []).filter((m) => !wanted.has(m.id));
        if (Array.isArray(db.modelCatalog.available)) {
          db.modelCatalog.available = db.modelCatalog.available.filter((id) => !wanted.has(id));
        }
        persist();
        const removed = beforeCount - db.modelCatalog.list.length;
        console.log(`[admin] ${me.username} 批量删除 ${removed} 个模型`);
        return send(200, { ok: true, deleted: removed, remaining: db.modelCatalog.list.length });
      }
      if (body && body.reset === true) {
        for (const item of targets) {
          item.credits = String(item.upstreamCredits || "");
          delete item.creditsLocked;
        }
        persist();
        console.log(`[admin] ${me.username} 批量恢复上游倍率 ${targets.length} 个模型`);
        return send(200, { ok: true, updated: targets.length, reset: true });
      }
      /* 10-22 用户「闲时倍率设置不考虑到?」——批量也要能设/清**闲时系数**，语义与单条一致：
         undefined = 不动；null = 清除（跟随全局）；数字 = 该模型自己的系数。 */
      const hasCredits = body && body.credits !== undefined;
      const hasOffPeak = body && body.offPeakRate !== undefined;
      if (!hasCredits && !hasOffPeak) return send(400, { ok: false, error: "没有要修改的字段" });
      let credits = "";
      if (hasCredits) {
        const rawCredits = String(body.credits === undefined ? "" : body.credits).trim();
        if (rawCredits && rawCredits !== "0") {
          const n = Number(rawCredits.replace(/^x/i, ""));
          if (!Number.isFinite(n) || n < 0) return send(400, { ok: false, error: "倍率必须是数字（如 0.29）或留空表示免费" });
          credits = "x" + String(n);
        }
      }
      let opRate;
      if (hasOffPeak) {
        const rawOp = body.offPeakRate === null ? "" : String(body.offPeakRate).trim();
        if (rawOp === "") opRate = null;
        else {
          const n = Number(rawOp.replace(/^x/i, ""));
          if (!Number.isFinite(n) || n < 0) return send(400, { ok: false, error: "闲时倍率必须是数字（如 0.05）或留空表示跟随全局" });
          opRate = n;
        }
      }
      for (const item of targets) {
        if (hasCredits) {
          item.credits = credits;
          item.creditsLocked = true;
        }
        if (hasOffPeak) {
          if (opRate === null) delete item.offPeakRate;
          else item.offPeakRate = opRate;
        }
      }
      persist();
      console.log(`[admin] ${me.username} 批量更新 ${targets.length} 个模型：${hasCredits ? `倍率=${credits || "免费"}（已钉住）` : ""}${hasCredits && hasOffPeak ? "、" : ""}${hasOffPeak ? `闲时=${opRate === null ? "跟随全局" : opRate}` : ""}`);
      return send(200, { ok: true, updated: targets.length, credits: hasCredits ? credits : undefined, offPeakRate: hasOffPeak ? opRate : undefined });
    }
    /* ── 10-18 闲时（限时）倍率：管理员可改 ──────────────────────────────
       语义：**折扣系数，乘在模型倍率之上**。读取用于界面回显 + 显示当前命中窗口。 */
    /* 管理员：**批量**改倍率 / 批量恢复上游（10-22 用户：「模型管理加一个批量管理功能」）。
       ⛔ 与单条 /admin/models/credits 同一套归一化与「钉住」语义，只是作用在多个 id 上；
       ⛔ 先全量校验再落字段（中途 400 不能留下半截状态）。 */
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

    /* ── 10-23 管理端「已开通成员」：在知识库 / 记忆中心里直接管人 ─────────────────
       ⛔ 用户令「不用去后台了」⇒ 成员列表 + 批量管理必须在本服务完成。
       ⛔ 本接口只读本地状态（权益 + 已下发凭据），**不逐个去问上游** —— 否则一屏用户
          会把 WeKnora / MemHub 打成串行队列（实测建库 1~3s/个）。 */
    if (p === "/admin/members" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const feature = String(url.searchParams.get("feature") || "knowledge") === "memory" ? "memory" : "knowledge";
      const rows = db.users.map((u) => memberRow(u, feature));
      const summary = {
        total: rows.length,
        active: rows.filter((r) => r.enabled).length,
        expired: rows.filter((r) => r.expired).length,
        off: rows.filter((r) => !r.enabled && !r.expired).length,
        provisioned: rows.filter((r) => r.enabled && r.hasResource).length,
      };
      return send(200, { ok: true, feature, label: FEATURE_LABEL[feature], summary, users: rows });
    }

    /* 批量开通 / 续期 / 改额度 / 停用 —— 一次请求在服务端串行执行（前端不用发 N 个请求，
       中途关页面也不会做一半）。⛔ 逐条返回失败原因，不许"显示成功但其实没做"。 */
    if (p === "/admin/entitlements/batch" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const feature = String((body && body.feature) || "") === "memory" ? "memory" : "knowledge";
      const action = String((body && body.action) || "grant").trim();
      if (!["grant", "quota", "off"].includes(action)) return send(400, { ok: false, error: "action 必须是 grant / quota / off" });
      const names = Array.from(new Set((Array.isArray(body && body.users) ? body.users : []).map((x) => String(x || "").trim()).filter(Boolean)));
      if (!names.length) return send(400, { ok: false, error: "没有选择账号" });
      const missing = names.filter((n) => !db.users.some((u) => u.username === n));
      if (missing.length) return send(404, { ok: false, error: "用户不存在：" + missing.slice(0, 5).join(", ") });
      const days = Number(body && body.days);
      const quotaMb = body && body.quotaMb !== undefined ? Math.max(0, Number(body.quotaMb) || 0) : undefined;
      const quota = body && body.quota !== undefined ? Math.max(0, Number(body.quota) || 0) : undefined;
      const done = [], failed = [];
      for (const username of names) {
        try {
          const payload = { username, feature };
          if (action === "grant") {
            payload.enabled = true;
            /* ⛔ days 必须显式给：不传 = 只改额度（grantFeature 的「留空不动」语义） */
            payload.days = Number.isFinite(days) && days >= 0 ? days : 30;
            if (quotaMb !== undefined) payload.quotaMb = quotaMb;
            if (quota !== undefined) payload.quota = quota;
          } else if (action === "quota") {
            if (quotaMb !== undefined) payload.quotaMb = quotaMb;
            if (quota !== undefined) payload.quota = quota;
            if (quotaMb === undefined && quota === undefined) throw new Error("没有要改的额度");
          } else {
            payload.enabled = false;
          }
          const state = grantFeature(username, feature, {
            disable: payload.enabled === false,
            days: payload.days === undefined ? null : payload.days,
            quotaMb: payload.quotaMb,
            quota: payload.quota,
            note: `管理员 ${me.username} 批量操作`,
          });
          if (state.enabled) provisionFor(username, feature);
          done.push(username);
        } catch (e) {
          failed.push({ username, error: sanitize(String((e && e.message) || e)) });
        }
      }
      persist();
      console.log(`[admin] ${me.username} 批量${action} ${FEATURE_LABEL[feature]}：成功 ${done.length} / 失败 ${failed.length}`);
      return send(200, { ok: true, feature, action, done: done.length, failed, users: names });
    }

    /* 批量「补齐 / 重建」资源：开通了但库或钥匙没建出来的账号，一键重试。
       ⛔ 只补缺，不删旧 —— 删库是不可逆动作，放在清理接口里且要显式点名。 */
    if (p === "/admin/members/ensure" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const feature = String((body && body.feature) || "") === "memory" ? "memory" : "knowledge";
      const wanted = Array.isArray(body && body.users) ? body.users.map((x) => String(x || "").trim()).filter(Boolean) : [];
      const targets = wanted.length
        ? db.users.filter((u) => wanted.includes(u.username))
        : db.users.filter((u) => featureState(u.username, feature).enabled);
      if (!targets.length) return send(400, { ok: false, error: "没有可处理的账号" });
      const done = [], failed = [];
      for (const u of targets) {
        try {
          const r = feature === "knowledge" ? await ensureKnowledgeFor(u.username) : await ensureMemoryFor(u.username);
          if (r && r.ok === false) failed.push({ username: u.username, error: sanitize(String(r.error || "未就绪")) });
          else done.push(u.username);
        } catch (e) {
          failed.push({ username: u.username, error: sanitize(String((e && e.message) || e)) });
        }
        await new Promise((r2) => setTimeout(r2, 300));   // ⛔ 串行 + 间隔：WeKnora 建库要 1~3s
      }
      console.log(`[admin] ${me.username} 补齐${FEATURE_LABEL[feature]}资源：成功 ${done.length} / 失败 ${failed.length}`);
      return send(200, { ok: true, feature, done: done.length, failed, total: targets.length });
    }

    /* 管理端：知识库已注册模型（下拉数据源）。⛔ 只读探测，失败回 ok:false 让前端回落手填 */
    if (p === "/admin/service-models" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      if (!WEKNORA_ADMIN_KEY) return send(200, { ok: false, error: "知识库密钥未配置，无法读取模型列表", llm: [], embed: [], vlm: [] });
      try {
        const all = await weknoraModelList();
        const pick = (pred) => all.filter(pred);
        return send(200, {
          ok: true,
          count: all.length,
          base: WEKNORA_BASE,
          /* ⛔ VLLM 里也含 "LLM" 三个字母：不排除它的话，视觉模型会混进「问答模型」下拉。 */
          llm: pick((m) => /knowledgeqa/i.test(m.type) || (/llm|chat|qa/i.test(m.type) && !/vllm|vision/i.test(m.type))),
          embed: pick((m) => /embedding/i.test(m.type)),
          vlm: pick((m) => /vllm|vision/i.test(m.type)),
          all,
          current: { llm: WEKNORA_LLM_MODEL_ID, embed: WEKNORA_EMBED_MODEL_ID, vlm: WEKNORA_VLM_MODEL_ID },
        });
      } catch (e) {
        return send(200, { ok: false, error: sanitize(String((e && e.message) || e)), llm: [], embed: [], vlm: [] });
      }
    }

    /* 把当前模型配置**应用到所有已建好的用户库**（只改配置，不动文档）。
       ⛔ 这是「模型映射到前端」真正生效的那一步：只写 db 只会影响"之后新建"的库。 */
    if (p === "/admin/kb/apply-models" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      if (!WEKNORA_ADMIN_KEY) return send(400, { ok: false, error: "知识库密钥未配置" });
      if (!WEKNORA_LLM_MODEL_ID && !WEKNORA_EMBED_MODEL_ID) return send(400, { ok: false, error: "先在上面选好问答 / 嵌入模型再应用" });
      const body = await readBody().catch(() => ({}));
      const wanted = Array.isArray(body && body.users) ? body.users.map((x) => String(x || "").trim()).filter(Boolean) : [];
      const rows = Object.entries(db.integrations || {})
        .filter(([username, it]) => it && it.kbId && (!wanted.length || wanted.includes(username)))
        .map(([username, it]) => ({ username, kbId: String(it.kbId) }));
      if (!rows.length) return send(200, { ok: true, total: 0, done: 0, failed: [], note: "还没有已建好的用户库" });
      const done = [], failed = [];
      for (const r of rows) {
        try {
          await weknoraAdmin(`/api/v1/initialization/config/${r.kbId}`, { method: "PUT", body: kbModelConfigBody() });
          const slot = integrationSlot(r.username);
          slot.vlmModelId = WEKNORA_VLM_MODEL_ID || "";
          done.push(r.username);
        } catch (e) {
          failed.push({ username: r.username, error: sanitize(String((e && e.message) || e)) });
        }
        await new Promise((r2) => setTimeout(r2, 250));
      }
      persist();
      console.log(`[admin] ${me.username} 应用知识库模型到 ${done.length}/${rows.length} 个库，失败 ${failed.length}`);
      return send(200, { ok: true, total: rows.length, done: done.length, failed });
    }

    /* 管理端：记忆网关的实际状态（版本 / 上游 / 限流 / 存储）。
       ⛔ 记忆网关**没有运行期配置接口**（模型与上游都在容器 env 里）⇒ 这里只读，
          把"到底在用哪个上游"摊开给管理员看，别做成一个点了没反应的假开关。 */
    if (p === "/admin/service-health" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const which = String(url.searchParams.get("which") || "memory") === "kb" ? "kb" : "memory";
      const base = which === "kb" ? WEKNORA_BASE : MEMHUB_PROXY_BASE;
      try {
        const res = await fetch(`${base}/health`, { headers: which === "kb" ? { "X-API-Key": WEKNORA_ADMIN_KEY } : {} });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        return send(200, { ok: res.ok, status: res.status, base, health: json, note: json ? "" : sanitize(text.slice(0, 200)) });
      } catch (e) {
        return send(200, { ok: false, status: 0, base, health: null, note: sanitize(String((e && e.message) || e)) });
      }
    }

    /* ── 10-23（用户令「知识库要配 LLM 密钥的吧，留好配置 API 地址和密钥的接口」）──────
       知识库要能答话，光有"选哪个模型"不够：那个模型背后得有 **API 地址 + 密钥**。
       这三条把 WeKnora 的模型资源完整搬到前端：
         POST /admin/service-models/save   建/改一个 remote 模型（地址进 parameters.base_url）
         POST /admin/service-models/key    只换密钥（走 PUT /models/{id}/credentials）
         POST /admin/service-models/delete 删模型（⛔ 被知识库引用时 WeKnora 会拒，原样回报）
       ⛔ 实测口径（10-23）：
         · 创建 `POST /api/v1/models` 需要 name / type / source 必填，`parameters` 必填；
         · **更新**（PUT）里带的 api_key 会被**忽略**并写 warn 日志 ⇒ 密钥只能走 /credentials；
         · base_url 有 SSRF 校验：**内网/不可解析地址会被拒**（报 "Base URL 未通过安全校验"）。 */
    if (p === "/admin/service-models/save" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      if (!WEKNORA_ADMIN_KEY) return send(400, { ok: false, error: "知识库密钥未配置，无法写模型" });
      const body = await readBody();
      const type = String((body && body.type) || "").trim();
      if (!KB_MODEL_TYPES.includes(type)) return send(400, { ok: false, error: "类型必须是 " + KB_MODEL_TYPES.join(" / ") });
      const name = String((body && body.name) || "").trim();
      if (!name) return send(400, { ok: false, error: "模型名不能为空（填上游真实的 model id，如 deepseek-v4.1-flash）" });
      const norm = normalizeUpstreamBase(String((body && body.baseUrl) || "").trim());
      if (!norm.ok) return send(400, { ok: false, error: "API 地址：" + norm.error });
      const apiKey = String((body && body.apiKey) || "").trim();
      const displayName = String((body && body.displayName) || "").trim() || name;
      const provider = String((body && body.provider) || "openai").trim() || "openai";
      let id = String((body && body.id) || "").trim();
      try {
        if (id) {
          /* 更新：先把原 parameters 取回来再合并 —— PUT 是"整体替换"，只发 base_url 会把
             embedding_parameters / supports_vision 这些丢掉。 */
          const cur = await weknoraAdmin(`/api/v1/models/${id}`);
          const params = Object.assign({}, (cur && cur.data && cur.data.parameters) || {}, { base_url: norm.base, provider });
          await weknoraAdmin(`/api/v1/models/${id}`, { method: "PUT", body: { name, display_name: displayName, type, parameters: params } });
        } else {
          const created = await weknoraAdmin("/api/v1/models", {
            method: "POST",
            body: { name, display_name: displayName, type, source: "remote", description: "云管理后台配置", parameters: { base_url: norm.base, provider } },
          });
          id = String((created && created.data && created.data.id) || "");
          if (!id) throw new Error("知识库没有返回模型 id");
        }
        if (apiKey) await weknoraAdmin(`/api/v1/models/${id}/credentials`, { method: "PUT", body: { api_key: apiKey } });
        console.log(`[services] ${me.username} ${apiKey ? "写入" : "保存"}知识库模型 ${name}（${type}）→ ${norm.base}`);
        return send(200, { ok: true, id, name, type, baseUrl: norm.base, hasKey: Boolean(apiKey), created: !body.id });
      } catch (e) {
        const msg = sanitize(String((e && e.message) || e));
        const ssrf = /SSRF|安全校验/i.test(msg);
        return send(502, {
          ok: false,
          error: msg,
          hint: ssrf
            ? "知识库会拦截内网/无法解析的地址（SSRF 防护）。请填公网可访问的 API 根地址（含 /v1），或让运维把该域名加入 WeKnora 的 SSRF_WHITELIST_EXTRA。"
            : "",
        });
      }
    }
    if (p === "/admin/service-models/key" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      if (!WEKNORA_ADMIN_KEY) return send(400, { ok: false, error: "知识库密钥未配置" });
      const body = await readBody();
      const id = String((body && body.id) || "").trim();
      const apiKey = String((body && body.apiKey) || "").trim();
      if (!id) return send(400, { ok: false, error: "缺少模型 id" });
      if (!apiKey) return send(400, { ok: false, error: "密钥不能为空" });
      try {
        await weknoraAdmin(`/api/v1/models/${id}/credentials`, { method: "PUT", body: { api_key: apiKey } });
        console.log(`[services] ${me.username} 更新知识库模型密钥 ${id}`);
        return send(200, { ok: true, id });
      } catch (e) {
        return send(502, { ok: false, error: sanitize(String((e && e.message) || e)) });
      }
    }
    if (p === "/admin/service-models/delete" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      if (!WEKNORA_ADMIN_KEY) return send(400, { ok: false, error: "知识库密钥未配置" });
      const body = await readBody();
      const id = String((body && body.id) || "").trim();
      if (!id) return send(400, { ok: false, error: "缺少模型 id" });
      try {
        await weknoraAdmin(`/api/v1/models/${id}`, { method: "DELETE" });
        console.log(`[services] ${me.username} 删除知识库模型 ${id}`);
        return send(200, { ok: true, id });
      } catch (e) {
        return send(502, { ok: false, error: sanitize(String((e && e.message) || e)), hint: "被知识库引用的模型不能删，先换掉再删" });
      }
    }

    /* 管理端：权益总览 / 开通·续期·停用 / 价格表 */
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
      /* ⛔ 展开 prev：直接重建对象会把 `modelMap`（模型映射表）冲掉 —— 改个地址就丢映射。 */
      db.upstream = { ...prev, base: norm.base, catalogBase, gatewayKey: providedKey || prev.gatewayKey || "" };
      persist();
      console.log(`[upstream] ${me.username} 更新上游 API 地址 → ${norm.base}${catalogBase ? `（目录同步 → ${catalogBase}）` : ""}${providedKey ? "（含新网关密钥）" : "（沿用原网关密钥）"}${norm.insecure ? " ⚠️ http 明文" : ""}`);
      /* ★ 10-22 用户：「只要 API 地址和密钥填了，模型目录就要更新并且识别出来」——
         保存后立刻按候选表拉一次目录（最多等 6 秒，慢上游不拖死保存按钮）；
         结果随回执返回，面板直接显示「已识别 N 个模型」或具体原因。 */
      const pulled = await Promise.race([
        pullModelCatalog(true),
        new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
      ]);
      return send(200, {
        ok: true, base: norm.base, catalogBase,
        hasKey: Boolean(db.upstream.gatewayKey),
        insecure: norm.insecure,
        warning: norm.insecure ? "http 明文传输：仅建议内网使用" : "",
        sync: pulled
          ? { ok: Boolean(pulled.ok), count: pulled.count || 0, error: pulled.error || "", message: pulled.message || "" }
          : { ok: false, pending: true, message: "上游响应较慢，目录同步仍在后台进行（打开「模型管理」会自动补一次）" },
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
      /* 依次探测**候选表**（catalogCandidates：管理目录 → OpenAI /v1/models → 通用 /models）。
         ⛔ 全部标 optional：对普通网关来说「没有管理目录」是正常形态 —— 有一行通了就说明
            这个地址能识别模型，其余未提供的不算错误（旧版把 404 画成红叉，用户以为坏了）。
         ⛔ 只有**一条都不通**时，才逐条给原因。 */
      const probes = catalogCandidates(norm.base).map((c) => ({ name: c.name, url: c.url, wantList: true, optional: true }));
      /* 10-22 用户：「openai 跟 Claude 协议都识别不出来吗」——同一个 /v1/models 换 Anthropic 头
         （x-api-key + anthropic-version）常能多列出一批 Claude 模型，这里单独作为一条候选。 */
      if (key) {
        const { openai } = splitUpstreamBase(norm.base);
        probes.push({ name: "Claude 协议 /v1/models", url: `${openai}/models`, authMode: "anthropic", wantList: true, optional: true });
      }
      const results = [];
      for (const probe of probes) results.push(await probeGet(norm.base, probe, key, "bearer"));
      /* ⛔ 10-22「上面识别出来了，下面自动更新啊」——用户把绿色 ✓ 当成"识别成功"，
         但那三行其实是「HTTP 200 + 返回网页」，一个模型都没解析出来。
         ⇒ 结论必须分三档：① 真拿到列表（recognized）② 能连通但读不到列表 ③ 完全不通。
         只有第 ① 档才算成功；第 ② 档给⚙️ 可复制的下一步（多半是地址填成了控制台首页）。 */
      const modelProbe = results.find((x) => x.ok && x.count != null) || null;
      const reachable = results.find((x) => x.ok) || null;
      console.log(`[upstream] ${me.username} 连通性测试 ${norm.base} → ${modelProbe ? `识别 ${modelProbe.count} 个模型` : reachable ? "能连通但读不到列表" : "不可达"}（${results.map((x) => `${x.status || "ERR"}@${x.ms}ms`).join(" / ")}）`);
      return send(200, {
        ok: Boolean(reachable),
        recognized: Boolean(modelProbe),
        base: norm.base,
        /* 10-22 现场：用户在上面「测试连通性」看到 12 个模型，但没点「保存」⇒
           下面的模型管理还在用旧地址（mg 控制台）拉目录，永远空。
           这两个字段让面板能直接提示「本次测试的地址还没保存」，并给一键保存。 */
        savedBase: currentUpstreamBase(),
        savedCatalogBase: currentCatalogBase(),
        changed: norm.base !== currentUpstreamBase() || norm.base !== currentCatalogBase(),
        insecure: norm.insecure,
        warning: norm.insecure ? "http 明文传输：仅建议内网使用" : "",
        hasKey: Boolean(key),
        elapsedMs: Date.now() - started,
        probes: results,
        modelCount: modelProbe ? modelProbe.count : null,
        modelSource: modelProbe ? modelProbe.name : "",
        message: modelProbe
          ? `连通：${modelProbe.name}，${modelProbe.count} 个模型（${modelProbe.ms}ms）`
          : reachable
            ? (reachable.html
              ? `这个地址打开的是**控制台网页**（返回 HTML${reachable.redirected ? "，并跳转到登录页" : ""}），不是模型 API。请改填 API 根：https://你的域名/v1 或 https://你的域名/claude-code/default（本产品记忆网关的默认实例）。`
              : "能连通，但读不到模型列表：返回内容不是模型数组。确认这个地址是不是 API 根（多数网关是 /v1/models）。")
            
            : "不可达：候选端点都不通 —— 看下面每一行的原因",
      });
    }
    if (p === "/admin/upstream/models" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const base = currentCatalogBase();
      const catalogIds = (db.modelCatalog.list || []).map((m) => String((m && m.id) || "").trim()).filter(Boolean);
      if (!base) return send(200, { ok: false, ids: catalogIds, fromCatalog: catalogIds.length, error: "catalog-not-configured", message: "还没配置上游地址" });
      const authKey = WBM_TOKEN || currentGatewayKey();
      let fetched = { rows: null, source: "", tried: [] };
      try {
        /* ⛔ 面板打开就问上游一次：上游若半死（TCP 连着不回包）会把这个接口挂住 ⇒ 12 秒上限，
           超时按「没给出列表」处理，面板照常手填，不等它。 */
        fetched = await Promise.race([
          collectCatalogRows(base, authKey),
          new Promise((resolve) => setTimeout(() => resolve({ rows: null, source: "", tried: ["上游 12 秒内没响应（超时）"] }), 12_000)),
        ]);
      } catch (error) {
        fetched = { rows: null, source: "", tried: [classifyFetchError(error)] };
      }
      /* 上游 id 优先（保持上游顺序），再补目录里有、上游没回的（例如别名的旧记录）。 */
      const ids = [];
      const seen = new Set();
      for (const row of fetched.rows || []) {
        const id = String((row && row.id) || "").trim();
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
      const upstreamCount = ids.length;
      for (const id of catalogIds) if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      /* 展示名（映射后）：目录里有就用目录的 upstreamName 兜底，再套映射表。
         ⛔ 下拉显示映射后名字、value 仍是上游 id —— 不然选中就直接拿错 id 去调用了。 */
      const nameOf = new Map();
      for (const item of (db.modelCatalog.list || [])) {
        const id = String((item && item.id) || "").trim();
        if (id) nameOf.set(id, String(item.upstreamName || item.id || ""));
      }
      for (const row of fetched.rows || []) {
        const id = String((row && row.id) || "").trim();
        if (id && !nameOf.has(id)) nameOf.set(id, String((row && (row.name || row.id)) || ""));
      }
      const items = ids.map((id) => ({ id, name: nameOf.get(id) || id }));
      return send(200, {
        ok: Boolean(upstreamCount),
        ids,
        items,
        upstreamCount,
        fromCatalog: catalogIds.length,
        source: fetched.source || "",
        base,
        message: upstreamCount
          ? `上游实时返回 ${upstreamCount} 个模型${ids.length > upstreamCount ? `（并上目录共 ${ids.length} 个）` : ""}`
          : `上游没给出模型列表：${(fetched.tried || []).join(" · ") || "未知原因"}`,
      });
    }
    /* 管理员：**聊天测试**（10-22 用户：「加一个聊天测试功能」）。
       ⛔ 只发一次非流式请求，用来现场验证「这个模型 id 到底通不通 / 上游到底回什么」；
       ⛔ 先试 OpenAI 兼容 /chat/completions，404/405 再试 Anthropic /messages（同一把密钥换头）。 */
    if (p === "/admin/upstream/chat" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const model = String(body && body.model || "").trim();
      const prompt = String(body && body.prompt || "").trim();
      if (!model) return send(400, { ok: false, error: "先选一个模型 id" });
      if (!prompt) return send(400, { ok: false, error: "先写一句测试内容" });
      const key = currentGatewayKey();
      const { openai } = splitUpstreamBase(currentCatalogBase());
      /* ⛔ 10-22 用户截图「回复被截断」（我是腾讯开发的混…）：默认 256 太小 ——
         推理型模型（hy4 / deepseek 等）会把预算烧在 reasoning 上，正文只剩几个字。
         ⇒ 默认 1024、上限 4096；并把 finish_reason 带回去，让面板能明说「是被上限截断」。 */
      const asked = Number(body && body.maxTokens);
      const maxTokens = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : 1024, 16), 4096);
      const t0 = Date.now();
      const tried = [];
      /* ① OpenAI 兼容 */
      try {
        const res = await fetch(`${openai}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: false }),
          signal: AbortSignal.timeout(45000),
        });
        const text = await res.text().catch(() => "");
        if (res.ok) {
          let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON 交给下面兜底 */ }
          const choice = j && j.choices && j.choices[0];
          const content = choice && (choice.message && choice.message.content || choice.text);
          if (content != null) {
            return send(200, {
              ok: true, protocol: "openai", status: res.status, ms: Date.now() - t0,
              model: (j && j.model) || model, content: String(content).slice(0, 8000), usage: (j && j.usage) || null,
              maxTokens, finishReason: String((choice && choice.finish_reason) || ""),
            });
          }
          /* 只有思考、没有正文（推理模型 max_tokens 被 reasoning 吃光）⇒ 明说，别报「没解析出内容」。 */
          const reasoning = choice && choice.message && choice.message.reasoning_content;
          if (reasoning) {
            return send(200, {
              ok: true, protocol: "openai", status: res.status, ms: Date.now() - t0,
              model: (j && j.model) || model, content: "", reasoning: String(reasoning).slice(0, 2000),
              usage: (j && j.usage) || null, maxTokens, finishReason: String((choice && choice.finish_reason) || "length"),
              message: `只有思考、没有正文：这个模型把 ${maxTokens} 个 token 全用在推理上了 —— 把「回复上限」调大再试`,
            });
          }
          tried.push(`/chat/completions 200 但没解析出内容：${text.slice(0, 120)}`);
        } else {
          tried.push(`/chat/completions HTTP ${res.status}：${text.slice(0, 160)}`);
        }
      } catch (error) { tried.push(`/chat/completions ${classifyFetchError(error)}`); }
      /* ② Anthropic Messages 回落 */
      try {
        const res = await fetch(`${openai}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(45000),
        });
        const text = await res.text().catch(() => "");
        let j = null; try { j = JSON.parse(text); } catch { /* ignore */ }
        const content = j && Array.isArray(j.content) ? j.content.map((c) => c && c.text).filter(Boolean).join("\n") : "";
        if (res.ok && content) {
          return send(200, {
            ok: true, protocol: "anthropic", status: res.status, ms: Date.now() - t0,
            model: (j && j.model) || model, content: content.slice(0, 8000), usage: (j && j.usage) || null,
            maxTokens, finishReason: String((j && j.stop_reason) || ""),
          });
        }
        tried.push(res.ok ? "/messages 200 但没解析出内容" : `/messages HTTP ${res.status}：${text.slice(0, 160)}`);
      } catch (error) { tried.push(`/messages ${classifyFetchError(error)}`); }
      return send(502, { ok: false, error: "chat-test-failed", message: sanitize(tried.join(" · ")) || "上游没有返回内容" });
    }
    /* ── 知识库 / 记忆空间上游（10-18 用户令「为知识库和记忆空间预留可配置的接口」）────
       GET  回显：面板值 + **当前生效值** + 环境变量原值（管理员一眼看出"到底在用哪个"）
       POST 保存：字段留空 = **回退环境变量**（⛔ 不是清空）；保存后 applyServiceOverrides **热生效**
       POST .../test：只发 GET 的连通性探测（⛔ 绝不发写请求；⛔ 回执不含密钥）
       ⛔ 地址走 normalizeUpstreamBase（http / 裸主机 / 内网 / 端口 / 路径前缀都接受）。 */
    /* 管理员：**聊天测试的可选模型**（10-22 用户：「这个聊天测试，能选的模型太少了」）。
       原来下拉只吃 `/admin/models` 的目录（会被排除表/清空/手动删除影响，且目录没同步就没了）
       ⇒ 这里**直接问上游要全量 id**（不落盘、不过滤、不去重合并目录），再并上目录里的 id。
       ⛔ 只读：不改目录、不改倍率；拉不到就回 `ids` = 目录那份 + 逐条原因，面板照常手填。 */
    if (p === "/admin/services" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const kb = db.services.kb || {};
      const mem = db.services.memory || {};
      const mask = (v) => (v ? String(v).slice(0, 6) + "***" + String(v).slice(-4) : "");
      return send(200, {
        ok: true,
        kb: {
          base: kb.base || "", publicBase: kb.publicBase || "", key: mask(kb.key), hasKey: Boolean(kb.key),
          llmModelId: kb.llmModelId || "", embedModelId: kb.embedModelId || "", vlmModelId: kb.vlmModelId || "",
          /* ⛔ 面板要显示"实际在用的模型"：只回 db 里那份时，靠环境变量配好的部署会显示空框，
             管理员以为没配（线上实测）。三个 effective* 就是真正生效的值。 */
          effectiveLlmModelId: WEKNORA_LLM_MODEL_ID, effectiveEmbedModelId: WEKNORA_EMBED_MODEL_ID, effectiveVlmModelId: WEKNORA_VLM_MODEL_ID,
          uiBase: kb.uiBase || "", effectiveUiBase: kbUiBase(),
          effectiveBase: WEKNORA_BASE, effectiveHasKey: Boolean(WEKNORA_ADMIN_KEY),
          envBase: WEKNORA_ENV_BASE, envHasKey: Boolean(WEKNORA_ENV_ADMIN_KEY),
        },
        memory: {
          base: mem.base || "", proxyBase: mem.proxyBase || "", publicBase: mem.publicBase || "",
          proxyPublicBase: mem.proxyPublicBase || "", key: mask(mem.key), hasKey: Boolean(mem.key),
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
      /* ⛔ 10-23 拆成两个中心后，前端每次只提交自己那半边 —— 这里必须「传了才改」，
         否则保存知识库会把记忆的 base/key 一起写成空串（配置静默丢失）。 */
      const kbIn = body && body.kb ? body.kb : null;
      const memIn = body && body.memory ? body.memory : null;
      if (!kbIn && !memIn) return send(400, { ok: false, error: "没有要保存的内容（kb / memory 至少给一个）" });
      const normOne = (raw, label) => {
        const s = String(raw == null ? "" : raw).trim();
        if (!s) return { ok: true, value: "" };                    // 留空 ⇒ 回退环境变量
        const n = normalizeUpstreamBase(s);
        return n.ok ? { ok: true, value: n.base } : { ok: false, error: label + "：" + n.error };
      };
      const keep = (v) => String(v == null ? "" : v).trim();
      /* ⛔ 密钥字段：传空或传回掩码（含 ***）一律保留原值 —— 否则面板点一次「保存」就把真 key 写坏 */
      const keepKey = (v, prev) => { const t = keep(v); if (!t || t.indexOf("***") >= 0) return String(prev || ""); return t; };

      if (kbIn) {
        const cur = db.services.kb || {};
        /* ⛔ 用「{...cur} 再覆盖」而不是整对象重建：publicBase / uiBase 这类
           前端不一定每次都提交的字段，重建会把它们静默清空（10-23 拆中心时踩过一次）。
           ⛔ base 也改成"传了才改"：模型接入保存时只提交模型字段，不能顺手把 base 清成空串
           （空串在这些部署里代表"回退环境变量"，而有的部署环境变量本来就是空的 ⇒ 知识库直接断）。 */
        const next = Object.assign({}, cur);
        if (kbIn.base !== undefined) {
          const kbBase = normOne(kbIn.base, "知识库地址");
          if (!kbBase.ok) return send(400, { ok: false, error: kbBase.error });
          next.base = kbBase.value;
          if (kbIn.publicBase === undefined) next.publicBase = kbBase.value ? next.publicBase || "" : "";
        }
        if (kbIn.publicBase !== undefined) next.publicBase = normOne(kbIn.publicBase, "知识库对外地址").value || "";
        if (kbIn.uiBase !== undefined) next.uiBase = normOne(kbIn.uiBase, "知识库后台地址").value || "";
        if (kbIn.key !== undefined) next.key = keepKey(kbIn.key, cur.key);
        /* ⛔ 模型 id 只在**提交了**这个字段时才改：只保存地址时不能把模型配置清空 */
        if (kbIn.llmModelId !== undefined) next.llmModelId = keep(kbIn.llmModelId);
        if (kbIn.embedModelId !== undefined) next.embedModelId = keep(kbIn.embedModelId);
        if (kbIn.vlmModelId !== undefined) next.vlmModelId = keep(kbIn.vlmModelId);
        db.services.kb = next;
      }
      if (memIn) {
        const cur = db.services.memory || {};
        const next = Object.assign({}, cur);
        if (memIn.base !== undefined) {
          const memBase = normOne(memIn.base, "记忆地址");
          if (!memBase.ok) return send(400, { ok: false, error: memBase.error });
          next.base = memBase.value;
        }
        if (memIn.proxyBase !== undefined) {
          const memProxy = normOne(memIn.proxyBase, "记忆代理地址");
          if (!memProxy.ok) return send(400, { ok: false, error: memProxy.error });
          next.proxyBase = memProxy.value;
        }
        if (memIn.publicBase !== undefined) next.publicBase = normOne(memIn.publicBase, "记忆空间对外地址").value || "";
        if (memIn.proxyPublicBase !== undefined) next.proxyPublicBase = normOne(memIn.proxyPublicBase, "记忆代理对外地址").value || "";
        if (memIn.key !== undefined) next.key = keepKey(memIn.key, cur.key);
        if (memIn.instance !== undefined) next.instance = keep(memIn.instance);
        db.services.memory = next;
      }
      persist();
      applyServiceOverrides();                                     // ⛔ 热生效（免重启）
      console.log(`[services] ${me.username} 更新：知识库 → ${WEKNORA_BASE}（key ${WEKNORA_ADMIN_KEY ? "已配" : "未配"}）· 记忆 → ${MEMHUB_BASE}（代理 ${MEMHUB_PROXY_BASE}，key ${MEMHUB_ADMIN_KEY ? "已配" : "未配"}）`);
      return send(200, {
        ok: true,
        kb: { effectiveBase: WEKNORA_BASE, effectiveHasKey: Boolean(WEKNORA_ADMIN_KEY) },
        memory: { effectiveBase: MEMHUB_BASE, effectiveProxyBase: MEMHUB_PROXY_BASE, effectiveHasKey: Boolean(MEMHUB_ADMIN_KEY) },
      });
    }
    /* 10-23：「对外访问地址」单独一个接口改 —— ⛔ 不复用 /admin/services POST：
       那里会把前端回传的掩码密钥当真值写回（sk-W6im***KEM），一次保存就把 key 弄坏。 */
    if (p === "/admin/services/public-base" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const normOne = (raw, label) => {
        const v = String(raw == null ? "" : raw).trim();
        if (!v) return { ok: true, value: "" };
        const n = normalizeUpstreamBase(v);
        return n.ok ? { ok: true, value: n.base } : { ok: false, error: label + "：" + n.error };
      };
      /* ⛔ 三个地址各自独立：前端每次只提交其中一项 ⇒ **没提交的不能动**
         （旧实现把另一侧写成空串 —— 保存知识库对外地址会把记忆的对外地址抹掉）。 */
      const out = {};
      if (body && body.memory !== undefined) {
        const memPub = normOne(body.memory, "记忆空间对外地址");
        if (!memPub.ok) return send(400, { ok: false, error: memPub.error });
        db.services.memory = Object.assign({}, db.services.memory || {}, { publicBase: memPub.value });
        out.memory = memPub.value;
      }
      if (body && body.kb !== undefined) {
        const kbPub = normOne(body.kb, "知识库对外地址");
        if (!kbPub.ok) return send(400, { ok: false, error: kbPub.error });
        db.services.kb = Object.assign({}, db.services.kb || {}, { publicBase: kbPub.value });
        out.kb = kbPub.value;
      }
      /* 10-23：知识库**后台界面**地址（与 API 对外地址分开）—— 填 8080 是 API，
         点「打开后台」只会看到一句 401 JSON。这里单列一个字段，留空 = 按端口约定推导。 */
      if (body && body.kbUi !== undefined) {
        const kbUi = normOne(body.kbUi, "知识库后台地址");
        if (!kbUi.ok) return send(400, { ok: false, error: kbUi.error });
        db.services.kb = Object.assign({}, db.services.kb || {}, { uiBase: kbUi.value });
        out.kbUi = kbUi.value;
      }
      persist();
      console.log("[services] " + me.username + " 地址更新：" + JSON.stringify(out) + " ⇒ 后台入口 " + kbUiBase());
      return send(200, { ok: true, ...out, effectiveUiBase: kbUiBase() });
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
          { name: "记忆面板首页", path: "/", wantList: false },
          /* ⛔ GET 这个端点返回 404：MemHub 的用户列表只接受 POST 且要 X-Tdai 头（10-23 实测） */
          { name: "记忆服务（用户列表，需 X-Tdai-User-Key）", path: "/api/v1/meta/user/list", method: "POST", body: {}, wantList: false, serviceId: MEMHUB_INSTANCE },
        ];
      const results = [];
      for (const probe of probes) results.push(await probeGet(norm.base, probe, key, isKb ? "x-api-key" : "tdai"));
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
    /* ── 功能开关（10-18）：管理员决定用户能不能同步会话 ─────────────────────
       ⛔ POST 只接受**白名单字段**（`sessionSync`），不做通用设置写入 ——
          否则这个接口迟早被人拿来塞任意键，变成一个"能改任意配置"的后门。 */
    if (p === "/admin/features" && req.method === "GET") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      return send(200, {
        ok: true,
        features: {
          sessionSync: !(db.features && db.features.sessionSync === false),
          /* ⛔ 10-18 用户令「加自动更新重启」：默认**关** —— 自动重启会中断正在使用的人。 */
          autoUpdate: Boolean(db.features && db.features.autoUpdate === true),
          version: APP_VERSION,
        },
      });
    }
    if (p === "/admin/features" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      if (typeof body.sessionSync !== "boolean") return send(400, { ok: false, error: "sessionSync 必须是 true 或 false" });
      if (typeof db.features !== "object" || !db.features) db.features = {};
      db.features.sessionSync = body.sessionSync;
      if (typeof body.autoUpdate === "boolean") db.features.autoUpdate = body.autoUpdate;
      persist();
      console.log(`[features] ${me.username} 会话同步 → ${body.sessionSync ? "开启" : "关闭"}`);
      return send(200, { ok: true, sessionSync: body.sessionSync });
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
      /* ⛔⛔ 三条更新路径（用户令：「我这个是跑在服务器上部署的啊，为什么不行，那我的不行，人家的也都不行」
         —— 自部署服务一键更新是**标准能力**，安全性靠工程手段保证，不靠拒绝）：
           ① git 部署 ⇒ `git pull --ff-only`（失败 reset 回滚）
           ② 非 git 但有 selfupdate.sh ⇒ 跑脚本（下载→备份→覆盖→语法闸；**下载不全则整体中止**）
           ③ 两者都没有 ⇒ 告诉管理员怎么装脚本
         ⛔ 非 git 路径必须 `--no-restart`：脚本里的 systemctl restart 会把**正在跑脚本的我们**杀掉，
            响应就发不出去 ⇒ 重启统一由本进程 exit 交给 systemd。 */
      const scriptPath = [path.join(__dirname, "selfupdate.sh"), path.join(repoRoot, "selfupdate.sh")]
        .find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "";
      const isGit = fs.existsSync(path.join(repoRoot, ".git"));
      if (!isGit && !scriptPath) {
        return send(400, {
          ok: false,
          error: "既不是 git 部署，也没有自助更新脚本（selfupdate.sh），无法一键更新。",
          hint: "把仓库里的 cloud/scripts/selfupdate.sh 放到 server.js 同目录（chmod +x），再点一次；或按 README 用分发包装。",
        });
      }
      const { execFile } = require("node:child_process");
      const execIn = (cmd, args, cwd) => new Promise((resolve) => {
        execFile(cmd, args, { cwd, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || (err && err.message) || "").trim() });
        });
      });
      let detail = "";
      let changed = true;
      if (isGit) {
        const git = (args) => execIn("git", args, repoRoot);
        const before = await git(["rev-parse", "--short", "HEAD"]);
        const pull = await git(["pull", "--ff-only"]);
        if (!pull.ok) {
          await git(["reset", "--hard", "ORIG_HEAD"]);
          console.log(`[ops] ${me.username} git 更新失败：${pull.err.slice(0, 200)}`);
          return send(500, { ok: false, error: "更新失败（已回滚到原 commit）：" + (pull.err || "未知错误"), detail: pull.out });
        }
        const after = await git(["rev-parse", "--short", "HEAD"]);
        changed = before.out !== after.out;
        detail = `${before.out} → ${after.out}\n${pull.out}`;
      } else {
        const r = await execIn("bash", [scriptPath, "--no-restart"], repoRoot);
        if (!r.ok) {
          console.log(`[ops] ${me.username} 脚本更新失败：${r.err.slice(0, 200)}`);
          return send(500, {
            ok: false,
            error: "更新失败（脚本已中止，本机文件未被部分覆盖，服务未重启）",
            detail: (r.out + "\n" + r.err).slice(0, 2000),
          });
        }
        detail = r.out;
      }
      console.log(`[ops] ${me.username} 更新完成（${isGit ? "git" : "脚本"}），正在重启`);
      send(200, {
        ok: true, restarting: true, changed,
        mode: isGit ? "git" : "script",
        output: detail.slice(0, 2000),
        message: isGit
          ? (changed ? "已更新代码，正在重启（约 3–5 秒恢复）" : "代码已是最新，正在重启")
          : "文件已更新（旧版备份为 *.bak-*），正在重启（约 3–5 秒恢复）",
      });
      setTimeout(() => process.exit(0), 600);
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
    /* 10-19：给**已有账号**批量补建知识库/记忆空间（注册自动建的改动只对新用户生效）。
       ⛔ 串行 + 间隔 600ms：weknora 建库 1~3s，并发会把它的 postgres 打满（实测过的教训）。
       ⛔ 幂等：已存在的 kbId 会走 ensure* 的"存活检查"，不会重复建。 */
    /* 10-19：**仅本机**触发批量补建（管理员没登录态时用）。
       ⛔ 只接受 127.0.0.1 / ::1 —— 外部访问一律 403，等同不暴露。 */
    if (p === "/internal/provision-all" && req.method === "POST") {
      const localOnly = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (!localOnly) return send(403, { ok: false, error: "仅限本机" });
      const targets = db.users.filter((u) => u && u.username);
      const out = { total: targets.length, knowledge: { ok: 0, fail: 0 }, memory: { ok: 0, fail: 0 } };
      (async () => {
        for (const u of targets) {
          for (const feature of ["knowledge", "memory"]) {
            try {
              const r = feature === "knowledge" ? await ensureKnowledgeFor(u.username) : await ensureMemoryFor(u.username);
              if (r && r.ok === false) { out[feature].fail += 1; console.warn(`[provision-all] ${u.username}/${feature} 未就绪：${sanitize(String(r.error || ""))}`); }
              else out[feature].ok += 1;
            } catch (e) {
              out[feature].fail += 1;
              console.warn(`[provision-all] ${u.username}/${feature} 失败：${sanitize(String((e && e.message) || e))}`);
            }
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        console.log(`[provision-all] 完成：知识库 ${out.knowledge.ok}/${out.knowledge.fail}，记忆 ${out.memory.ok}/${out.memory.fail}`);
      })();
      return send(200, { ok: true, queued: targets.length });
    }
    if (p === "/admin/provision-all" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const targets = db.users.filter((u) => u && u.username && String(u.username) !== me.username);
      const out = { total: targets.length, knowledge: { ok: 0, fail: 0 }, memory: { ok: 0, fail: 0 } };
      (async () => {
        for (const u of targets) {
          for (const feature of ["knowledge", "memory"]) {
            try {
              const r = feature === "knowledge" ? await ensureKnowledgeFor(u.username) : await ensureMemoryFor(u.username);
              if (r && r.ok === false) { out[feature].fail += 1; console.warn(`[provision-all] ${u.username}/${feature} 未就绪：${sanitize(String(r.error || ""))}`); }
              else out[feature].ok += 1;
            } catch (e) {
              out[feature].fail += 1;
              console.warn(`[provision-all] ${u.username}/${feature} 失败：${sanitize(String((e && e.message) || e))}`);
            }
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        console.log(`[provision-all] 完成：知识库 ${out.knowledge.ok}/${out.knowledge.fail}，记忆 ${out.memory.ok}/${out.memory.fail}`);
      })();
      return send(200, { ok: true, queued: targets.length, note: "后台串行补建中，看 journalctl -u chc-account 的 [provision-all] 日志" });
    }
    if (p === "/admin/invites/delete" && req.method === "POST") {
      if (!me || me.role !== "admin") return send(403, { ok: false, error: "需要管理员权限" });
      const body = await readBody();
      const row = inviteRow(body && body.code);
      if (!row) return send(404, { ok: false, error: "邀请码不存在" });
      /* ⛔ 只允许删「从未用过」的码：usedCount>0 的码上记着账，且已注册账号的 inviteCode 指向它，
         删了会让来源悬空、历史统计失真 ⇒ 这类码只能停用。 */
      if (Number(row.usedCount || 0) > 0) {
        return send(409, { ok: false, error: "这个码已经用过 " + row.usedCount + " 次，只能停用不能删除" });
      }
      const code = row.code;
      delete db.invites[code];
      persist();
      console.log("[invite] " + me.username + " 删除邀请码 " + code + "（未使用）");
      return send(200, { ok: true });
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

/* ── 自动更新（10-18）：每 6 小时检查，仅当 db.features.autoUpdate === true 时应用 ──
   ⛔ 默认关；开启后有新版才覆盖并重启（systemd Restart=always 拉起）。
   ⛔ 检查失败静默；只有真的升级了（日志出现 VERSION →）才重启。 */
setInterval(() => {
  try {
    if (!(db.features && db.features.autoUpdate === true)) return;
    const script = [path.join(__dirname, "selfupdate.sh"), path.join(__dirname, "..", "selfupdate.sh")].find((f) => { try { return fs.existsSync(f); } catch { return false; } });
    if (!script) return;
    const { execFile } = require("node:child_process");
    execFile("bash", [script, "--no-restart"], { cwd: path.dirname(script), timeout: 240000, maxBuffer: 4194304 }, (err, stdout) => {
      if (err) { console.error("[auto-update] 失败：", String(err.message).slice(0, 200)); return; }
      if (/VERSION →/.test(String(stdout || ""))) {
        console.log("[auto-update] 已更新，2s 后重启");
        setTimeout(() => process.exit(0), 2000);
      }
    });
  } catch (e) { /* 静默 */ }
}, 6 * 60 * 60 * 1000);

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
