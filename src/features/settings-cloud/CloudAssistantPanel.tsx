/**
 * 云助手专属（10-13 建，10-28 收窄）—— 设备/座位 + 限时福利 + 云端更新。
 *
 * ⛔ 10-28 起**账号、积分、会话同步已搬到设置页「云账号」**（自桌面仓移植的账号体系）：
 *   这里是它们之外、桌面版没有的云助手独有能力，避免两套界面各读一份同一状态。
 *
 * 职责：
 *   · 连接状态：闸是否开 / 绑定的账号 / 服务器可达性 / 设备凭据
 *   · 设备（座位）列表：名称 + token 指纹 + 吊销（吊销后那台机器要重新认领）
 *   · 更新：cloud:update/check（探测云端 version.json）—— download/apply 尚未接线，**如实显示**
 *   · 限时福利：内置供应商的可用模型 + 倍率 + 勾选（勾了才有权限调用）
 *   · 断开连接 / 换绑：清空绑定与设备 token ⇒ 回到配对卡
 *
 * 数据源（两路，都有就都用，缺了就防御性降级）：
 *   · IPC（并行线的 cloud-reserve-ipc 域）：cloud:device/list / cloud:device/unbind / cloud:update/check
 *   · HTTP（headless）：/api/cloud-state、/api/cloud-devices、/api/cloud-points、/api/cloud-models、
 *     /api/cloud-models-enabled、/api/cloud-disconnect 等
 *
 * ⛔⛔ 必须 portal 到 `document.body`（同 CloseConfirmDialog：transform 祖先会让 fixed 退化）。
 * ⛔ **自包含**：状态与请求都在本组件内；挂载处一行。桌面版（无 __CHC_ACCOUNT_GATE__）
 *    账户菜单里**不会出现**这个入口 ⇒ 本组件也不会被挂载。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, Gift, HelpCircle, RefreshCw, RotateCw, Search, Unplug, X } from "lucide-react";
import {syncLimitedBenefitQuiet, syncLimitedBenefit } from "../limited-benefit";
/* ⛔ 胶囊开关一律走统一 ToggleSwitch（守卫【234】⑧）：颜色/暗色适配由它一处负责，
   不在业务组件里手写轨道与圆点（手写必然各写各的色值 ⇒ 主题一变就露馅）。 */
import { ToggleSwitch } from "../../components/SettingsWidgets";
/* ⛔ 令牌数格式化复用 model-specs 的单一真相源（1_050_000 → "1.05M"），不在此处抄第二份。 */
import { formatTokenCount } from "../../lib/model-specs";
/* 闲时（限时）倍率状态（10-18）：用户令「管理员可以修改倍率」+「夜间/闲时倍率」。
   ⛔ 用 currentOffPeakWindow **现算**，不读 /models 回执里的 `offPeak.active`
   —— 后者是拉目录那一刻的快照，管理员刚改完时段就会显示错（可差好几分钟）。
   判定语义（服务端本地时间 / 左闭右开 / 跨零点）与积分扣减同一份实现，见 credit-estimate.mjs。 */
import { currentOffPeakWindow } from "../../lib/cloud-credit-store";
import type { OffPeakConfig } from "../../lib/credit-estimate.mjs";

type CloudState = {
  gated: boolean;
  paired: boolean;
  machinePaired: boolean;
  machineAccounts: string[];
  account: string | null;
  seats: { owner: string; users: Record<string, string> };
  hasDeviceToken: boolean;
  serverReachable: boolean;
  webEntry: string;
  plan: string;
  cloudFeatures: { sessionIndex: boolean; cloudExec: boolean };
};
/* 与服务端 /device/list 同构（10-14 设备令牌通道）：id 才是吊销用的键，
   ⛔ 旧字段 tokenFingerprint 早就不存在了 —— 用它当标签 + 拿 name 当 id 调用 ⇒ 永远 404 = "点解绑没反应"。 */
type DeviceRow = { id: string; name: string; claimedAt?: number; lastSeen?: number; current?: boolean };
type UpdateInfo = { available: boolean; current?: string; latest?: string; url?: string; notes?: string; reason?: string };
/** 模型目录（服务端 /models）。倍率 credits 形如 "x0.29"。
    ⛔ 已勾选状态是**每个模型内联的 `enabled` 布尔**（不是顶层 id 数组）——
    按顶层数组读会永远拿到空集（"勾了刷新又没了"）。 */
type ModelRow = {
  id: string;
  name?: string;
  credits?: string | number;
  enabled?: boolean;
  /* 10-14 起渲染的规格字段（服务端 /models 对**每个**模型都带，见本文件模型行的注释）：
     上下文长度 / 最大输出 / 是否支持图片 / 是否推理模型。显式声明而不是靠索引签名，
     否则 `m.supportsImages === true` 会因 unknown 判等被 TS 拦下。 */
  contextLength?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  [k: string]: unknown;
};
type ModelsInfo = {
  ok: boolean;
  provider?: { id: string; name: string; baseUrl: string; ready: boolean; hasProxyToken?: boolean };
  models?: ModelRow[];
  enabledCount?: number;
  total?: number;
  /* 闲时（限时）倍率快照（服务端 /models 带，10-18 新增 tzOffsetMinutes）。
     ⛔ 只用它判断"启没启用、有哪些时段"；"现在命中哪个"一律**现算**
     （回执里的 active 是拉取那一刻的旧值，管理员刚改完时段就会显示错）。 */
  offPeak?: OffPeakConfig;
  error?: string;
};
/* ⛔ 云通道（cloud:device/*、cloud:update/check）只存在于**云助手仓**的 manifest ⇒
   桌面仓的生成类型里没有它们。组件只在云助手形态挂载，但 TS 对三仓统一编译
   ⇒ 这里走**防御性可选类型**，运行时有就有、没有就不调（绝不在桌面仓硬引）。 */
type CloudOnlyApi = {
  cloudDeviceList?: () => Promise<{ devices: DeviceRow[] }>;
  cloudDeviceUnbind?: (name: string) => Promise<{ ok: boolean; removed: string; remaining: number }>;
  cloudUpdateCheck?: () => Promise<UpdateInfo>;
};
const cloudApi = (): CloudOnlyApi => window.codex as unknown as CloudOnlyApi;

async function fetchCloudState(): Promise<CloudState | null> {
  try {
    const headers: Record<string, string> = {};
    const token = localStorage.getItem("chc-token");
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch("/api/cloud-state", { headers, cache: "no-store" });
    return r.ok ? ((await r.json()) as CloudState) : null;
  } catch {
    return null;   // 桌面版没有这个端点（页面只在云助手形态出现）——防御
  }
}

export function CloudAssistantPanel({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings?: (page: string) => void }) {
  const [state, setState] = useState<CloudState | null>(null);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [note, setNote] = useState("");
  /* 10-15 用户令：限时福利区加一个「?」教程按钮 —— 勾选后模型那边要怎么做
     （先刷新模型列表，再保存重启）。点击展开/收起，无遮罩不挡操作。 */
  const [tipsOpen, setTipsOpen] = useState(false);

  const refresh = useCallback(() => {
    void fetchCloudState().then((s) => setState(s));
    /* ⛔ 10-14：列表走**本机 /api/cloud-devices**（内部用设备令牌问服务器）——
       原先走 cloud:device/list 需要网页会话，本机没有 ⇒ 列表恒空（"绑定账号 admin 但设备/座位 暂无"）。 */
    void fetch("/api/cloud-devices", { cache: "no-store" })
      .then((r) => r.json())
      .then((r: { ok?: boolean; devices?: DeviceRow[] }) => setDevices(Array.isArray(r?.devices) ? r.devices : null))
      .catch(() => setDevices(null));
  }, []);

  useEffect(() => {
    refresh();
    loadModels(); // 限时福利：可用模型 + 勾选
    /* ⛔ 打开面板即把服务端的勾选同步成本机供应商（幂等、静默）：
       本机模型下拉框只读本机供应商列表 ⇒ 不同步就是"勾了却选不到"（用户实测）。
       放在这里而不是"仅勾选时"：换机/重装/换绑后第一次打开面板自愈。 */
    syncLimitedBenefitQuiet();
  }, [refresh]);

  const runUpdateCheck = () => {
    setChecking(true);
    /* ⑤ 设备令牌更新通道：本机带设备令牌问服务器（/api/cloud-update-check → 账号服务
       /device/update/check）—— 更新渠道由服务器掌控（灰度/通道/最小版本）。 */
    fetch("/api/cloud-update-check", { cache: "no-store" })
      .then((r) => r.json())
      .then((r: UpdateInfo | { ok: boolean; error?: string }) => {
        if (r && "ok" in r && r.ok === false) { setUpdate({ available: false, reason: (r as { error?: string }).error || "检查失败" }); return; }
        setUpdate(r as UpdateInfo);
      })
      .catch(() => setUpdate({ available: false, reason: "网络错误" }))
      .finally(() => setChecking(false));
  };

  const unbind = (id: string) => {
    void fetch("/api/cloud-device-revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
      .then(() => refresh())
      .catch(() => undefined);
  };
  /* 当前这台：断开并回到配对（不自动重连 —— 让用户在配对页自己选"重连原号 / 换号"）。 */
  const reconnect = () => {
    setDisconnecting(true);
    void fetch("/api/cloud-disconnect", { method: "POST" })
      .then(() => { setTimeout(() => location.reload(), 400); })
      .catch(() => setDisconnecting(false));
  };
  /* 换绑：断开 + **强制打开登录表单**（switch=1，忽略网页当前登录态）⇒ 登另一个号即完成换绑。
     ⛔ 用户实测「我想换绑的机会都没有」—— 这条就是那个机会。 */
  const switchAccount = () => {
    setDisconnecting(true);
    void fetch("/api/cloud-disconnect", { method: "POST" })
      .then(() => {
        try { localStorage.removeItem("chc-token"); } catch { /* 忽略 */ }
        void fetch("/api/open-auth?switch=1", { method: "POST" }).catch(() => undefined);
        setTimeout(() => location.reload(), 800);
      })
      .catch(() => setDisconnecting(false));
  };

  /* ── 限时福利：模型目录（服务端 /models）+ 勾选（/models/enabled）─────────── */
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [modelsErr, setModelsErr] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [savingModels, setSavingModels] = useState(false);
  /* 本地选择集：从服务端每模型的 enabled 布尔派生；勾选后就地更新，落盘为 id 数组。 */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /* 10-15 用户令：云端模型模式开关（开启 = 只用云端目录里的模型，本地供应商停用且开关锁定） */
  const [cloudMode, setCloudMode] = useState<{ cloudModels: boolean } | null>(null);
  const [togglingCloud, setTogglingCloud] = useState(false);
  /* 「保存并重启」的**面板内确认**（10-16 用户令「不要有这种系统弹窗」）：
     ⛔ 不用 window.confirm —— 原生弹窗标题取页面 title（云助手里显示成
     "Codex Harness Desktop"）、样式与本产品无关，且阻塞主线程。 */
  const [restartAsk, setRestartAsk] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  useEffect(() => {
    /* ⛔ 必须 null 安全：老版本 dev/未重启主进程时 modelSourceGet 不存在，
       旧写法 `?.().then()` 会在 undefined 上调 then ⇒ 抛异常 ⇒ 状态卡在 null（开关永远禁用）。 */
    void (async () => {
      try {
        const fn = (window.codex as unknown as { modelSourceGet?: () => Promise<{ cloudModels: boolean }> }).modelSourceGet;
        const j = fn ? await fn() : null;
        setCloudMode(j && typeof j.cloudModels === "boolean" ? j : { cloudModels: false });
      } catch { setCloudMode({ cloudModels: false }); }
    })();
  }, []);
  function loadModels() {
    void fetch("/api/cloud-models", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: ModelsInfo) => {
        if (j && j.ok) {
          setModels(j);
          setPicked(new Set((j.models || []).filter((m) => m.enabled).map((m) => m.id)));
          setModelsErr("");
        } else { setModels(null); setModelsErr(j?.error === "no-device-token" ? "未绑定账号" : (j?.error || "读取失败")); }
      })
      .catch(() => { setModels(null); setModelsErr("网络错误"); });
  }
  /* 「保存并重启」的执行体。⛔⛔ 保存失败**不能**吞掉重启 ——
     旧写法把 `relaunchApp()` 与保存塞进同一个 try，`saveCustomModel()` 一旦 reject
     就静默跳过重启：用户点了「确定」却什么都没发生（10-16 用户实测报障「确认之后没有重启应用，假的」）。
     这两件事本就独立 —— 本地档案保存失败，云端勾选照样该生效。 */
  async function saveAndRestart() {
    setRestartBusy(true);
    setNote("");
    const api = window.codex as unknown as {
      saveCustomModel?: () => Promise<unknown>;
      relaunchApp?: () => Promise<void> | void;
    };
    if (typeof api.relaunchApp !== "function") {
      /* ⛔ 不静默：API 缺失时说清楚，否则又变成"点了没反应" */
      setRestartBusy(false);
      setNote("当前版本不支持一键重启，请手动退出应用后重新打开。");
      return;
    }
    try { await api.saveCustomModel?.(); }
    catch (e) { console.warn("[cloud-manage] 保存模型档案失败（仍继续重启）：", e); }
    /* ⛔⛔ 重启前必须等「云端勾选 → 本机档案」同步写完（10-16 用户实测的最后一环）：
       写档案的是 syncLimitedBenefit（主进程 limited-benefit:apply）。此前它是以静默不等待方式发起的，
       而这里紧接着 relaunch ⇒ **重启抢在写盘之前**，新进程读到的还是旧档案 ⇒ 用户看到「勾选后下拉不更新」。
       ⛔ 同步失败仍继续重启（与上面 saveCustomModel 同款语义）：本地失败不该挡住用户已保存的云端勾选。 */
    try { await syncLimitedBenefit(); }
    catch (e) { console.warn("[cloud-manage] 勾选同步失败（仍继续重启）：", e); }
    try { await api.relaunchApp(); }
    catch (e) {
      console.warn("[cloud-manage] 重启调用失败：", e);
      setRestartBusy(false);
      setNote("重启失败：" + ((e as Error)?.message || "未知错误"));
    }
  }
  /* 勾选去抖 500ms 后再落盘（连点不会再打一串请求）。
     ⛔ 服务端契约是 `{ ids: [...] }` 整集覆盖 —— 发 `{ enabled }` 会被静默丢掉（勾选存不进去）。 */
  const modelsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function commitModels(next: Set<string>) {
    setPicked(new Set(next));
    if (modelsTimer.current) clearTimeout(modelsTimer.current);
    modelsTimer.current = setTimeout(() => {
      setSavingModels(true);
      void fetch("/api/cloud-models-enabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...next] }),
      })
        .then((r) => r.json())
        .then((j: { ok?: boolean; enabled?: string[]; error?: string }) => {
          /* 服务端会过滤掉目录里不存在的 id ⇒ 以它的回执为准回填，避免本地与服务端不一致。 */
          if (j && j.ok && Array.isArray(j.enabled)) {
            setPicked(new Set(j.enabled));
            /* ⛔ 勾选落盘后必须**同步到本机供应商档案**：模型配置界面的模型列表就来自
               本机档案 —— 不同步，云端管理勾选后模型配置界面**永远不会更新**
               （10-15 用户实测「云端管理勾选了，这里没刷新」的根因）。
               交互按 10-15 用户令重做：勾选后**自动同步 + 列表自动刷新**（无弹窗），
               仅用轻提示告知「重启后完全生效」。 */
            syncLimitedBenefitQuiet();
            setNote("勾选已保存并同步到模型配置；重启应用后完全生效。");
          } else {
            /* ⛔⛔ 服务端拒绝 ⇒ 本地勾选必须**回滚**（10-14 实测）：写回静默失败时
               UI 显示勾上、服务端却没存 ⇒ 代理 403「该模型未在限时福利里启用」，
               测试连接还把它误报成「认证失败」—— 用户完全无从知道是勾选没存上。
               回滚到服务端目录的 enabled 真相 + 给出可见提示。 */
            setPicked(new Set(((models && models.models) || []).filter((m) => m.enabled).map((m) => m.id)));
            setNote("模型勾选保存失败" + (j && j.error ? `（${j.error}）` : "") + "——已恢复原勾选，请稍后重试");
          }
        })
        .catch(() => setNote("模型勾选保存失败（本机服务不可达）"))
        .finally(() => setSavingModels(false));
    }, 500);
  }
  const toggleModel = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    commitModels(next);
  };

  const disconnect = () => {
    setDisconnecting(true);
    void fetch("/api/cloud-disconnect", { method: "POST" })
      .then(() => {
        try { localStorage.removeItem("chc-token"); } catch { /* 忽略 */ }
        /* ⛔ 必须**整页重载**：界面内存里还揣着旧令牌/旧状态，只关弹窗会让各处加载
           陆续 401（收藏读取失败…）甚至反复自刷卡在启动页（用户实测）。
           重载 = 走全新未配对启动的同一条路径 ⇒ 配对卡正常出现。 */
        setTimeout(() => location.reload(), 300);
      })
      .catch(() => setDisconnecting(false));
  };

  if (typeof document === "undefined") return null;

  const paired = state?.machinePaired === true;
  const accounts = state?.machineAccounts ?? [];

  return createPortal(
    <div className="cloud-manage-backdrop" role="dialog" aria-modal="true" aria-label="设备与云服务">
      <div className="cloud-manage-card">
        <div className="cloud-manage-head">
          <span className="cloud-manage-title"><Cloud size={15} /> 设备与云服务</span>
          <button type="button" className="cloud-manage-x" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>

        <section className="cloud-manage-sec">
          <div className="cloud-manage-label">连接状态</div>
          {!state ? (
            <div className="cloud-manage-muted">读取中…</div>
          ) : (
            <div className="cloud-manage-kv">
              <div><span>配对闸</span><b>{state.gated ? "开（需网页账号）" : "关（独立模式）"}</b></div>
              <div><span>绑定账号</span><b>{accounts.length ? accounts.join("、") : "未绑定"}</b></div>
              <div><span>服务器</span><b>{state.serverReachable ? "可达" : "不可达"}</b></div>
              <div><span>设备凭据</span><b>{state.hasDeviceToken ? "已就绪" : "无"}</b></div>
              {/* ⛔ 配对码不在这里显示：外壳已不再注入 __CHC_PAIR_CODE__，"5 分钟有效"的旧语义也早改了
                  （现在是"认领成功或手动刷新前一直有效"）。配对码统一在**配对页**（/pair）展示，带复制与刷新。 */}
            </div>
          )}
        </section>

        <section className="cloud-manage-sec">
          <div className="cloud-manage-label">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Gift size={12} /> 限时福利{models?.provider?.name ? ` · ${models.provider.name}` : ""}
            </span>
          </div>
          {!models ? (
            <div className="cloud-manage-muted">{modelsErr || "读取中…"}</div>
          ) : (
            <>
              <div className="cloud-manage-muted" style={{ marginBottom: 8 }}>
                {models.provider?.ready
                  ? `已开通 · 共 ${models.total ?? models.models?.length ?? 0} 个模型，已勾选 ${picked.size} 个（勾选后才可调用，按倍率扣积分）`
                  : "供应商尚未就绪，请稍后再试"}
              </div>
              {/* 闲时（限时）倍率状态（10-18）：管理员改了时段/系数后，用户得能看见"现在算不算闲时"。
                  ⛔ 目录里没有 offPeak（旧服务端 / 尚未部署那半边）⇒ 整行**不出现** ——
                     不猜"未启用"（那是在说谎），也不写死"不在时段"。 */}
              {(() => {
                const op = models.offPeak;
                if (!op) return null;
                const win = currentOffPeakWindow(op);
                return (
                  <div className={"cloud-manage-muted" + (win ? " cloud-manage-offpeak-on" : "")} style={{ marginBottom: 8 }}>
                    {op.enabled !== true
                      ? "闲时倍率：未启用（不折扣）"
                      : win
                        ? `当前闲时「${win.label || "时段"}」${win.start}–${win.end} 点 ×${win.rate}（按服务器时间）`
                        : "当前不在闲时时段（不折扣）"}
                  </div>
                );
              })()}
              {/* 云端模型模式：开启 ⇒ 本地供应商全部停用、模型配置里的供应商开关被锁定。
                  ⛔ 色值与尺寸全部下沉到 39-cloud-manage.css（.cloud-mode-*）：
                     此前写成内联 style 且引用了 --brand / --ok-soft / --field 三个**不存在**的变量，
                     开启态轨道拿不到品牌色（看着像没开），--ok-soft 还回落成硬编码浅绿（暗色下刺眼）。 */}
              <div className={`cloud-mode-card ${cloudMode?.cloudModels ? "on" : ""}`}>
                <span className="cloud-mode-name">云端模型模式</span>
                <ToggleSwitch
                  className="cloud-mode-switch"
                  checked={!!cloudMode?.cloudModels}
                  disabled={togglingCloud || !models.provider?.ready}
                  label="云端模型模式"
                  title={cloudMode?.cloudModels
                    ? "已开启：只使用云端目录里勾选的模型（本地供应商已停用、模型配置里的开关已锁定）"
                    : "开启后只使用云端目录里勾选的模型，本地供应商自动停用并锁定开关"}
                  onChange={(next) => {
                    setTogglingCloud(true);
                    void (async () => {
                      try {
                        const fn = (window.codex as unknown as { modelSourceSet?: (i: { cloudModels: boolean }) => Promise<{ cloudModels: boolean }> }).modelSourceSet;
                        if (!fn) {
                          alert("当前版本不支持该开关：请重启 dev（npm run dev）后重试。\n主进程需要重新加载才能注册新 IPC。");
                          return;
                        }
                        const j = await fn({ cloudModels: next });
                        setCloudMode(j && typeof j.cloudModels === "boolean" ? j : { cloudModels: next });
                      } catch (e) {
                        alert("切换失败：" + ((e as Error)?.message || "未知错误"));
                      } finally { setTogglingCloud(false); }
                    })();
                  }}
                />
                <span className="cloud-mode-hint">
                  <b className="cloud-mode-state">{cloudMode?.cloudModels ? "已开启" : "已关闭"}</b>
                  {cloudMode?.cloudModels
                    ? " · 只使用云端目录里的模型（本地供应商已停用、开关已锁定）"
                    : " · 使用本地供应商（可在模型配置里切换）"}
                </span>
              </div>
              <div className="cloud-manage-search">
                <Search size={13} />
                <input
                  type="text"
                  value={modelQuery}
                  placeholder="搜索模型…"
                  onChange={(e) => setModelQuery(e.target.value)}
                  aria-label="搜索模型"
                />
              </div>
              <div className="cloud-manage-models">
                {(models.models || [])
                  .filter((m) => !modelQuery || m.id.toLowerCase().includes(modelQuery.toLowerCase()))
                  .map((m) => (
                    <label key={m.id} className="cloud-manage-model">
                      <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggleModel(m.id)} />
                      <span className="id">{m.id}</span>
                      {/* 10-14 用户令「模型的上下文数据和是否支持图片等等都更新出来，现在模型啥都没有」：
                          数据源 = 服务端 /models 的 contextLength · supportsImages · maxOutputTokens。
                          ⛔ 不要查本地 model-specs 表 —— 它只收录主流模型，限时福利的 hy4-preview /
                          step-5-preview / space-bunny 都不在表里 ⇒ 那几行原先一个徽标都没有。
                          服务端目录对**每个**模型都带这三个字段，直接渲染即可。 */}
                      {m.supportsImages === true ? <span className="tag">图片</span> : null}
                      {typeof m.contextLength === "number" ? (
                        <span className="spec">{formatTokenCount(m.contextLength)} 上下文</span>
                      ) : null}
                      {typeof m.maxOutputTokens === "number" ? (
                        <span className="spec">{formatTokenCount(m.maxOutputTokens)} 输出</span>
                      ) : null}
                      {m.credits ? <span className="cr">×{String(m.credits).replace(/^x/i, "")}</span> : null}
                    </label>
                  ))}
              </div>
              <div className="cloud-manage-actions" style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="cloud-manage-btn"
                  disabled={savingModels || !models.provider?.ready}
                  onClick={() => commitModels(new Set((models.models || []).map((m) => m.id)))}
                >
                  全选
                </button>
                <button
                  type="button"
                  className="cloud-manage-btn"
                  disabled={savingModels || !models.provider?.ready}
                  onClick={() => commitModels(new Set())}
                >
                  清空
                </button>
                <button type="button" className="cloud-manage-btn" onClick={loadModels}>
                  <RefreshCw size={13} /> 刷新
                </button>
                <button
                  type="button"
                  className="cloud-manage-btn"
                  disabled={savingModels || !models.provider?.ready}
                  title="保存当前勾选并重启应用（与模型配置的保存重启同逻辑）"
                  onClick={() => setRestartAsk(true)}
                >
                  <RotateCw size={13} /> 保存并重启
                </button>
                <button
                  type="button"
                  className="cloud-manage-btn"
                  aria-expanded={tipsOpen}
                  title="勾选之后要做什么（保存并重启 / 在哪选模型 / 云端模型模式）"
                  onClick={() => setTipsOpen((current) => !current)}
                >
                  <HelpCircle size={13} /> 勾选后怎么用
                </button>
              </div>
              {tipsOpen ? (
                <div className="cloud-manage-tips" role="note">
                  <div className="cloud-manage-tipstitle">勾选之后：</div>
                  <ol>
                    <li>
                      <b>点本面板的「保存并重启」</b> —— 就在上面那一排按钮里，确认后应用自动重启，
                      新勾选的模型即可调用（⛔ 不用再去模型配置界面点保存）。
                    </li>
                    <li>
                      <b>在模型下拉框里选</b> —— 重启后输入框旁的模型列表只显示<b>已勾选</b>的这些，
                      选中即可使用，按各自倍率扣积分。
                    </li>
                    <li>
                      <b>可选：开「云端模型模式」</b> —— 打开上面那张卡片的开关，之后只用这里勾选的模型，
                      本地其它供应商自动停用（模型配置里的开关会锁定）。
                    </li>
                  </ol>
                  <div className="cloud-manage-muted">
                    提示：未勾选的模型不会出现在下拉框里；取消勾选后同样要「保存并重启」才会生效。
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>


        <section className="cloud-manage-sec">
          <div className="cloud-manage-label">设备 / 座位</div>
          {devices === null ? (
            <div className="cloud-manage-muted">读取中…</div>
          ) : devices.length === 0 ? (
            <div className="cloud-manage-muted">暂无（配对后出现在这里）</div>
          ) : (
            <div className="cloud-manage-devices">
              {devices.map((d) => (
                <div key={d.id} className="cloud-manage-device">
                  <span className="nm">{d.name}{d.current ? "（本机）" : ""}</span>
                  <span className="fp">{d.current ? "当前在线" : d.lastSeen ? "最后在线 " + new Date(d.lastSeen).toLocaleDateString() : "已离线"}</span>
                  {d.current ? (
                    <button type="button" disabled={disconnecting} onClick={reconnect}>断开重连</button>
                  ) : (
                    <button type="button" onClick={() => unbind(d.id)}>解绑</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="cloud-manage-sec">
          <div className="cloud-manage-label">应用更新</div>
          <div className="cloud-manage-actions">
            <button type="button" className="cloud-manage-btn" onClick={runUpdateCheck} disabled={checking}>
              <RefreshCw size={13} className={checking ? "spin" : ""} />
              {checking ? "检查中…" : "检查云端更新"}
            </button>
          </div>
          {update ? (
            update.available ? (
              <div className="cloud-manage-note ok">
                发现新版本 v{update.latest}（当前 v{update.current}）。{update.notes}
                <br />下载与生效通道尚未接线（预留位），请用「检查更新」页完成安装。
              </div>
            ) : (
              <div className="cloud-manage-note">{update.reason ? `未探测到新版本：${update.reason}` : "已是最新版本"}</div>
            )
          ) : null}
        </section>

        <section className="cloud-manage-sec">
          <div className="cloud-manage-label">危险区</div>
          {/* ⛔ 10-14 用户令「我想换绑的机会都没有」：这一条就是换绑入口 ——
              断开本机绑定 + **强制打开登录表单**（switch=1，忽略网页当前登录态）
              ⇒ 登另一个号即完成换绑。 */}
          <button type="button" className="cloud-manage-btn danger" onClick={switchAccount} disabled={disconnecting}>
            <Unplug size={13} />
            {disconnecting ? "正在断开…" : "更换绑定账号（换号登录后重新认领）"}
          </button>
          <button type="button" className="cloud-manage-btn danger" onClick={disconnect} disabled={disconnecting || !paired}>
            <Unplug size={13} />
            {disconnecting ? "正在断开…" : "断开云端连接（清空绑定，回到配对）"}
          </button>
          <div className="cloud-manage-muted">断开后本机仍可离线使用独立功能，但云端管理与自动更新需要重新认领。要换号请用上面那条「更换绑定账号」。</div>
        </section>

        {note ? <div className="cloud-manage-note">{note}</div> : null}

        {/* 「保存并重启」的确认（10-16）：⛔ 走**全局确认框**（与 CloseConfirmDialog 同一套
            `.close-confirm-*` / z-index 950，**portal 到 body**），不做面板内嵌 ——
            用户明确「不要做内嵌的」。⛔ 必须 portal：带 transform 的祖先会成为 fixed 的
            包含块，不 portal 会跟着面板跑。 */}
        {restartAsk && typeof document !== "undefined"
          ? createPortal(
              <div className="close-confirm-backdrop" role="dialog" aria-modal="true" aria-label="保存并重启应用">
                <div className="close-confirm-card">
                  <div className="close-confirm-head">
                    <span className="close-confirm-title">保存并重启应用？</span>
                    <button type="button" className="close-confirm-x" aria-label="取消" onClick={() => setRestartAsk(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  <p className="close-confirm-desc">保存当前勾选的模型并重启应用，重启后新勾选的模型即可正常调用。</p>
                  <div className="close-confirm-actions">
                    <button type="button" className="close-confirm-btn" disabled={restartBusy} onClick={() => setRestartAsk(false)}>
                      取消
                    </button>
                    <button type="button" className="close-confirm-btn primary" disabled={restartBusy} onClick={() => { void saveAndRestart(); }}>
                      {restartBusy ? "重启中…" : "保存并重启"}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}

      </div>
    </div>,
    document.body,
  );
}
