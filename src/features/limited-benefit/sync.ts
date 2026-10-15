/**
 * 限时福利（limited-benefit 域，10-14）—— 前端接线面。
 *
 * 修复用户实测问题：「我选了模型生效，下拉框里面没有啊」。
 * 根因：面板里的"勾选"只写到服务端，本机模型下拉框只读本机供应商列表 ⇒ 勾了选不到。
 * 勾选语义（用户定稿）：**勾选 = 下拉框可见**，取消勾选即从下拉框消失。
 *
 * ⛔⛔ 为什么不让渲染层调 `custom-model:save` 来注册：
 *   那个 handler 的语义是「用户手动保存并让这个供应商**生效**」—— 它会在 enabled=true 时
 *   抢占生效位、把用户现有供应商全部禁用、并 applyCustomModel 重启引擎。
 *   自动注册做这些 = 擅自改用户配置。所以注册走主进程域的
 *   `limited-benefit:apply`（只写供应商行 + 不抢生效位，见主进程域文件头）。
 */
import { LIMITED_BENEFIT_ID, LIMITED_BENEFIT_NAME } from "./constants";

type CatalogModel = { id: string; name?: string; credits?: string; enabled?: boolean };
export type CatalogLike = {
  ok: boolean;
  provider?: { id: string; name: string; baseUrl: string; ready: boolean; hasProxyToken?: boolean };
  models?: CatalogModel[];
  error?: string;
};

type LimitedApi = {
  limitedBenefitCatalog?: () => Promise<CatalogLike>;
  limitedBenefitApply?: () => Promise<{ ok: boolean; models?: number; error?: string; changed?: boolean; promoted?: boolean }>;
  limitedBenefitStatus?: () => Promise<{ paired: boolean; hasToken: boolean; provider: string; models: number; registered: boolean }>;
};

const api = (): LimitedApi => window.codex as unknown as LimitedApi;


/**
 * 把「限时福利」的**已勾选模型**同步成本机供应商的模型列表（幂等，可反复调用）。
 * @param _catalog 兼容入参（目录由主进程自己拉，此处不用；保留签名便于将来复用）。
 * @returns 结果：models = 下拉框里应出现的条目数；promoted = 本次是否还占用了空的生效位。
 *
 * ⛔⛔ 成功后**必须刷新渲染层的供应商状态**：模型下拉框的开启条件是 `disabled={!customModel}`，
 *   而 `customModel` 只在页面加载时读一次（useModelProviders 的 `useEffect([])`）。自动注册
 *   发生在页面加载**之后** ⇒ 主进程那边生效位已经填上了，渲染层却还拿着 null，
 *   下拉框仍是灰的（用户看到的还是"选不到"）。`__refreshProviders` = useModelProviders 导出的
 *   refreshActive（同时刷新 providersList + currentProvider + customModel），注册后用一次即收敛。
 */
export type SyncResult = { ok: boolean; models: number; promoted: boolean; changed?: boolean; error?: string };

export async function syncLimitedBenefit(_catalog?: CatalogLike | null): Promise<SyncResult> {
  try {
    const r = await api().limitedBenefitApply?.();
    if (!r || !r.ok) return { ok: false, models: 0, promoted: false, error: r?.error || "apply-unavailable" };
    /* ⛔ 主进程侧 applyProvider 会 await applyCustomModel（重写 config.toml + 重建 MCP 段，
       实测要几秒）—— IPC resolve 时档案已写好，但渲染层 useModelProviders 的初始加载
       （`useEffect([])`）早在页面加载时就读过一次"空档案"并落进了 state。
       刷新一次通常够；但下单次调用可能撞上面板自身重渲染 / React 批处理，故**补一次延迟刷新**
       （幂等、只读，不做任何写入）确保 stale state 一定被覆盖 —— 这就是"勾了却选不到"的最后一跳。 */
    const refresh = () => { try { (window as unknown as { __refreshProviders?: () => void }).__refreshProviders?.(); } catch { /* 未接线时忽略 */ } };
    refresh();
    setTimeout(refresh, 800);
    /* 10-14：changed 透传给调用方。⛔ 置「pending-restart」标记的动作**不在本函数**——
       按 10-14 用户令「不是每次勾选都弹」，标记只在用户**手动点「同步到模型配置」按钮**时
       由 CloudManageDialog 置；配对后自动注册（Quiet）changed 再多也不弹不标记。 */
    const changed = Boolean((r as { changed?: boolean }).changed);
    return { ok: true, models: Number(r.models || 0), promoted: Boolean(r.promoted), changed };
  } catch (error) {
    return { ok: false, models: 0, promoted: false, error: String((error as Error)?.message ?? error) };
  }
}

/** 静默版：配对后自动注册 / 勾选落盘后同步（失败不阻断主流程）。 */
export function syncLimitedBenefitQuiet(): void {
  void syncLimitedBenefit().catch(() => undefined);
}

export { LIMITED_BENEFIT_ID, LIMITED_BENEFIT_NAME };
