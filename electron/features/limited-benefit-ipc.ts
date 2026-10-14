/**
 * 限时福利（limited-benefit 域，10-14）：把云端账号服务内置的**限时福利供应商**
 * （模型由 WorkBuddy Manager 目录同步而来，逐模型带积分倍率）接进本机模型体系。
 *
 * 为什么要有本域（用户实测「我选了模型生效，下拉框里面没有啊」）：
 *   云端管理面板里的"勾选"此前**只写到了服务端**（db.userModels），而本机模型下拉框
 *   只读本机供应商列表（bag.providersList / bag.customModel）⇒ 勾了也选不到。
 *   勾选语义（用户定稿）：**勾选 = 下拉框可见**，取消勾选即从下拉框消失。
 *
 * 本域职责（三件事，都在这一处）：
 *   ① catalog：带**设备令牌**拉服务端 /models（含每模型的 enabled 勾选状态与 credits 倍率）
 *   ② token：调 /proxy/token 签发本用户代理令牌（明文**仅此一次**），加密落盘后复用
 *   ③ apply：把「限时福利」写成本机供应商行（**只写这一行**，模型列表 = 已勾选的那些）
 *
 * ⛔⛔ 为什么 apply 不调 `custom-model:save`：那个 handler 的语义是「用户手动保存并让它生效」——
 *   在 enabled=true 时会**抢占生效位**（把用户现有供应商全部禁用）并 applyCustomModel 重启引擎。
 *   自动注册做这些 = 擅自改用户配置（项目纪律：行为语义未经确认不动）。
 *   所以这里只 upsert 一行 + 落盘，**绝不碰其他供应商行、绝不抢生效位**。
 *
 * ⛔⛔ 但**空生效位必须由本域补上**（10-14 用户实测第二跳：勾了还是选不到）：
 *   模型下拉框的开启条件是 `disabled={!customModel}`，而 customModel 读的是**生效档案**
 *   （单数 custom-model.json），不是供应商清单（复数 custom-models.json）。全新安装/从未配过
 *   供应商时生效位是空的 ⇒ 下拉框**整只是灰的、点不动**，用户看到的正是「我选了模型生效，
 *   下拉框里面没有啊」。
 *   ⇒ 判据只取「生效位为空」（readCustomModel() 返回 null 或 provider 不在已启用行里）：
 *      此时把本行提升为生效（写单数档案 + applyCustomModel 生成 config.toml + 设全局 Key）。
 *   ⛔ 绝不在**已有生效供应商**时抢位 —— 那种情况只让模型在清单里"可选"（用户想用自己从
 *      下拉框选中即可）。这条边界是本域唯一的"写生效位"入口，别扩大。
 * ⛔ 存储仍是同一份 custom-models.json（单一真相源），本域不自建存储。
 * ⛔ 代理令牌**绝不打日志**（前缀 wap_）：只在 token 通道返回一次给渲染层填 apiKey。
 */
import { app, net, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { defineFeature } from "../context";
import type { IpcHost } from "../ipc-host";
import { readCustomModel, readCustomModels, writeCustomModels } from "../main/01-model-catalog";
import { applyCustomModel } from "./custom-model-apply";
import { customModelFile } from "../runtime-paths";
import type { CustomModelFile, ProviderModel } from "./custom-model-types";

/** 域内 IPC 通道（三前缀同源：域 id = ipc-registry prefix）。 */
const CHANNELS = ["limited-benefit:catalog", "limited-benefit:token", "limited-benefit:status", "limited-benefit:apply"];

/** 供应商 id：只含字母数字下划线短横线（custom-model:save 的校验口径）。 */
export const LIMITED_BENEFIT_PROVIDER = "limited-benefit";
/** 供应商显示名（渲染层常量表逐字一致）。 */
export const LIMITED_BENEFIT_NAME = "限时福利";
/** 服务端同源代理路径后缀（上游真实地址与网关密钥只在服务端，客户端永不接触）。 */
const PROXY_PATH_SUFFIX = "/proxy/v1";
/** 服务端同源代理路径（本机伴生服务把 /cloud-api 透传到账号服务）。 */
const DEFAULT_ACCOUNTS_BASE = "https://ppz123.asia/cloud-api";

/**
 * 账号服务基址：env > 本机 config.json 的 accountsBase > 默认云端。
 * ⛔ 与 headless.ts 的解析顺序**逐字一致**（两处各自解析是既有现实，改一处必须改另一处）。
 */
function accountsBase(): string {
  const fromEnv = String(process.env.HARNESS_ACCOUNTS_BASE || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(cloudHome(), "config.json"), "utf8")) as { accountsBase?: unknown };
    if (typeof saved.accountsBase === "string") return saved.accountsBase.replace(/\/+$/, "");
  } catch { /* 没有配置文件就走默认 */ }
  return DEFAULT_ACCOUNTS_BASE;
}

/** 本机云账号目录（设备令牌 / 代理令牌所在）。⛔ 惰性求值，模块顶层不许调 app.getPath。 */
function cloudHome(): string {
  return process.env.HARNESS_CLOUD_HOME || path.join(app.getPath("home"), "Codex Assistant");
}

/** 设备令牌（配对后由 headless 写入）。没有 = 未配对 ⇒ 一切云端能力不可用。 */
function readDeviceToken(): string {
  try { return fs.readFileSync(path.join(cloudHome(), "device-token"), "utf8").trim(); } catch { return ""; }
}

/** 代理令牌缓存文件（本域专属；明文 + safeStorage 双轨：能加密就加密）。 */
function proxyTokenFile(): string { return path.join(cloudHome(), "limited-benefit-token"); }

function readProxyToken(): string {
  try {
    const raw = fs.readFileSync(proxyTokenFile(), "utf8");
    if (raw.startsWith("enc:")) {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw.slice(4), "base64")) : "";
    }
    return raw.trim();
  } catch { return ""; }
}

function writeProxyToken(token: string) {
  const dir = cloudHome();
  fs.mkdirSync(dir, { recursive: true });
  const payload = safeStorage.isEncryptionAvailable() ? "enc:" + safeStorage.encryptString(token).toString("base64") : token;
  fs.writeFileSync(proxyTokenFile(), payload, { mode: 0o600 });
}

export type ModelRow = { id: string; name?: string; credits?: string; enabled?: boolean };
export type CatalogResult = {
  ok: boolean;
  provider?: { id: string; name: string; baseUrl: string; ready: boolean; hasProxyToken?: boolean };
  models?: ModelRow[];
  error?: string;
};

/** 拉服务端模型目录（设备令牌）。 */
async function fetchCatalog(): Promise<CatalogResult> {
  const deviceToken = readDeviceToken();
  if (!deviceToken) return { ok: false, error: "no-device-token" };
  try {
    const r = await net.fetch(`${accountsBase()}/models`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const meta = (await r.json().catch(() => null)) as CatalogResult | null;
    if (!r.ok || !meta?.ok) return { ok: false, error: (meta as { error?: string } | null)?.error || `http-${r.status}` };
    return meta;
  } catch {
    return { ok: false, error: "accounts-unreachable" };
  }
}

/**
 * 取本用户代理令牌：优先读缓存，没有就签发一次。
 * ⛔ 明文只在这条通道返回（渲染层用它填供应商 apiKey，随即落进加密存储）。
 */
async function issueProxyToken(force: boolean): Promise<{ ok: boolean; token?: string; error?: string; reused?: boolean }> {
  if (!force) {
    const cached = readProxyToken();
    /* ⛔ 缓存只在**服务端也认为有令牌**时才算有效（服务端记录被清/换绑后，
       本机残留的旧明文会变成"一直在用却一直 401"）。服务端该字段由 /models 给出。 */
    if (cached) {
      const catalog = await fetchCatalog();
      if (catalog.ok && catalog.provider?.hasProxyToken) return { ok: true, token: cached, reused: true };
    }
  }
  const deviceToken = readDeviceToken();
  if (!deviceToken) return { ok: false, error: "no-device-token" };
  try {
    const r = await net.fetch(`${accountsBase()}/proxy/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const meta = (await r.json().catch(() => null)) as { ok?: boolean; token?: string; error?: string } | null;
    const token = r.ok && meta?.ok ? String(meta.token || "") : "";
    if (!token) return { ok: false, error: meta?.error || `http-${r.status}` };
    writeProxyToken(token);
    return { ok: true, token };
  } catch {
    return { ok: false, error: "accounts-unreachable" };
  }
}

/** 已注册状态（给界面显示用；不读云端）。 */
async function statusOf(): Promise<{ paired: boolean; hasToken: boolean; provider: string; models: number; registered: boolean }> {
  const row = (await readCustomModels()).find((entry) => entry.provider === LIMITED_BENEFIT_PROVIDER);
  return {
    paired: Boolean(readDeviceToken()),
    hasToken: Boolean(readProxyToken()),
    provider: LIMITED_BENEFIT_PROVIDER,
    models: Array.isArray(row?.models) ? row.models.length : 0,
    registered: Boolean(row),
  };
}

/**
 * 把「限时福利」写成本机供应商行（幂等）。
 * 模型列表 = 服务端**已勾选**的模型（勾选 = 下拉框可见）。
 * ⛔ 只 upsert 这一行：其他供应商行原样保留。
 * ⛔ 生效位只在**空着**的时候由本函数补上（见文件头「空生效位必须由本域补上」）。
 * ⛔ 没拿到代理令牌时不写 apiKey（保留已有行，避免把用户配好的东西写坏）。
 */
async function applyProvider(): Promise<{ ok: boolean; models: number; changed: boolean; promoted: boolean; error?: string }> {
  const catalog = await fetchCatalog();
  if (!catalog.ok) return { ok: false, models: 0, changed: false, promoted: false, error: catalog.error };
  if (!catalog.provider?.ready) return { ok: false, models: 0, changed: false, promoted: false, error: "provider-not-ready" };
  const picked = (catalog.models || []).filter((m) => m.enabled);
  const token = (await issueProxyToken(false)).token || "";

  const list = await readCustomModels();
  const index = list.findIndex((entry) => entry.provider === LIMITED_BENEFIT_PROVIDER);
  const previous = index >= 0 ? list[index] : null;

  const models: ProviderModel[] = picked.map((m) => ({ id: m.id }));
  const next: CustomModelFile = {
    ...(previous ?? {
      provider: LIMITED_BENEFIT_PROVIDER,
      name: LIMITED_BENEFIT_NAME,
      model: "",
      baseUrl: "",
      contextWindow: 256000,
      enabled: false,
    }),
    provider: LIMITED_BENEFIT_PROVIDER,
    name: LIMITED_BENEFIT_NAME,
    /* ⛔ model 只保留"原本就选中且仍在勾选列表里"的那个；否则留空。
       留空 = 该供应商没有当前模型，**不会**抢任何人的生效位。 */
    model: previous && picked.some((m) => m.id === previous.model) ? previous.model : "",
    baseUrl: `${accountsBase()}${PROXY_PATH_SUFFIX}`,
    wireApi: "chat",
    models,
    /* ⛔ enabled 必须为 true，否则**下拉框不显示它的模型**（模型列表的成员遍历里
       `enabled === false` 的行会被整行跳过 —— 这正是"勾了却选不到"的最后一道坎）。
       ⛔ 但这里**只置自己这一行**：绝不遍历禁用其它供应商、绝不抢生效位
       （那是 custom-model:save 的语义，属于用户主动动作；本域只让模型"可选"）。 */
    enabled: picked.length > 0 ? true : (previous?.enabled ?? false),
  } as CustomModelFile;

  const same = previous
    && JSON.stringify(previous.models ?? []) === JSON.stringify(next.models ?? [])
    && previous.baseUrl === next.baseUrl
    && previous.model === next.model
    && previous.enabled === next.enabled
    && Boolean(previous.encryptedKey) === Boolean(previous.encryptedKey || token);

  /* 首次注册才写令牌（已有 key 的行沿用原值：每次同步重写凭据毫无必要，且会无谓地
     改动用户可见的配置时间戳）。加密不可用时不写（供应商届时不可用，但绝不写明文）。 */
  const finalRow: CustomModelFile = previous?.encryptedKey
    ? next
    : { ...next, encryptedKey: token ? encryptToken(token) : undefined };

  if (index >= 0) list[index] = finalRow; else list.push(finalRow);
  if (!same) await writeCustomModels(list);

  const promoted = await promoteIfVacant(finalRow);
  return { ok: true, models: models.length, changed: !same, promoted };
}

/**
 * 生效位为空时把本行提升为生效供应商（**唯一**的抢位入口，判据极窄）。
 * 判据：单数档案不存在、或其 provider 已不属于"已启用行"（被删/被禁用）。
 * ⛔ 生效位有人（哪怕是别的供应商）⇒ 直接返回 false，一行不动。
 * ⛔ 无已勾选模型时不提升（空供应商生效只会让引擎报错）。
 *
 * ⛔ 提升时**必须同时选中一个模型**（`model` 留空会让渲染层 `disabled={!customModel}`
 *   那个判据之外的另一半也失效：下拉框可点但当前值是空的，引擎 thread/start 拿不到模型）。
 *   选谁：原有 model 优先；否则取第 1 个已勾选模型 —— 顺序即用户在面板里看到的顺序（id 升序）。
 */
async function promoteIfVacant(row: CustomModelFile): Promise<boolean> {
  if (!Array.isArray(row.models) || row.models.length === 0) return false;
  const active = await readCustomModel();
  if (active && active.provider !== row.provider) {
    // 生效位已有主人 —— 还要确认它是否仍然"活着"（行被删/被禁用时才收编）
    const alive = (await readCustomModels()).some((entry) => entry.provider === active.provider && entry.enabled !== false);
    if (alive) return false;
  }
  if (active?.provider === row.provider) return false;   // 已经是自己，无需重复写
  /* 补上 model（见上方说明）：提升即选第一个模型，用户打开下拉框时当前值不会是空的。 */
  const picked: CustomModelFile = { ...row, model: row.model || row.models[0]?.id || "" };
  /* 三种情况走到这里：①档案不存在 ②档案指向已被删除/禁用的供应商 ③档案本来就是这个 id
     （上面已排除）。统一写单数档案 + applyCustomModel（生成 config.toml + 下发全局 Key）。
     ⛔ restart:false —— 只是把空位填上，不需要打断任何在跑的回合（引擎下次读配置即生效）。 */
  await fs.promises.writeFile(customModelFile, JSON.stringify(picked, null, 2), "utf8");
  await applyCustomModel(picked, { restart: false });
  return true;
}

/** safeStorage 加密令牌；加密不可用时返回空串（宁可不写，也不写明文凭据）。 */
function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) return "";
  return safeStorage.encryptString(token).toString("base64");
}

export const limitedBenefitFeature = defineFeature<null>({
  id: "limited-benefit",
  inject: ["ipc"],
  setup: (ctx) => {
    const ipcHost = ctx.get<IpcHost>("ipc");
    if (!ipcHost) throw new Error("limited-benefit: 缺少 ipc 服务（宿主未提供？）");
    void CHANNELS;   // 通道清单在 manifest 登记；保留常量便于守卫比对（同 free-gateway 做法）

    /* 目录（含勾选状态 + 倍率）：面板与自动注册都用它。 */
    ipcHost.handle("limited-benefit:catalog", async () => fetchCatalog());
    /* 取代理令牌：{ force } 为真时强制重新签发（换绑后/令牌失效自愈用）。 */
    ipcHost.handle("limited-benefit:token", async (_event, input?: { force?: boolean }) => issueProxyToken(Boolean(input?.force)));
    /* 本机状态（不联网供应商存储，仅读令牌文件 + 供应商行）。 */
    ipcHost.handle("limited-benefit:status", async () => statusOf());
    /* 同步：按当前勾选把供应商行写成最新（勾选落盘后 / 配对后 / 修复按钮都调它）。 */
    ipcHost.handle("limited-benefit:apply", async () => applyProvider());
  },
});
