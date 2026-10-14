/**
 * 云端管理（10-13 二期）—— 账户菜单「云端管理」入口的**应用内**面板。
 *
 * 职责：把"这台机器与云端的关系"说清楚 + 给出动作：
 *   · 连接状态：闸是否开 / 绑定的账号 / 服务器可达性 / 本机配对码（未绑定时）
 *   · 设备（座位）列表：名称 + token 指纹 + 吊销（吊销后那台机器要重新认领）
 *   · 更新：cloud:update/check（探测云端 version.json）—— download/apply 尚未接线，**如实显示**
 *   · 断开连接：清空绑定与设备 token ⇒ 回到配对卡
 *
 * 数据源（两路，都有就都用，缺了就防御性降级）：
 *   · IPC（并行线的 cloud-reserve-ipc 域）：cloud:device/list / cloud:device/unbind / cloud:update/check
 *   · HTTP（headless 的 /api/cloud-state、/api/cloud-disconnect）：闸/账号/可达性/断开
 *
 * ⛔⛔ 必须 portal 到 `document.body`（同 CloseConfirmDialog：transform 祖先会让 fixed 退化）。
 * ⛔ **自包含**：状态与请求都在本组件内；挂载处一行。桌面版（无 __CHC_ACCOUNT_GATE__）
 *    账户菜单里**不会出现**这个入口 ⇒ 本组件也不会被挂载。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, RefreshCw, Unplug, X } from "lucide-react";

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

export function CloudManageDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<CloudState | null>(null);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [note, setNote] = useState("");

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
    <div className="cloud-manage-backdrop" role="dialog" aria-modal="true" aria-label="云端管理">
      <div className="cloud-manage-card">
        <div className="cloud-manage-head">
          <span className="cloud-manage-title"><Cloud size={15} /> 云端管理</span>
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
              {!paired && state.gated ? (
                <div>
                  <span>本机配对码</span>
                  <b className="cloud-manage-code">
                    {(window as unknown as { __CHC_PAIR_CODE__?: string }).__CHC_PAIR_CODE__ || "刷新本页获取（5 分钟有效）"}
                  </b>
                </div>
              ) : null}
            </div>
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
      </div>
    </div>,
    document.body,
  );
}
