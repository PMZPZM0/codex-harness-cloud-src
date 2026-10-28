/**
 * 云助手专属（10-28）—— 桌面仓云账号里**没有**、云助手独有的一块。
 *
 * 为什么单列：账号登录 / 模型 / 知识库 / 记忆 / 积分 / 会话同步已经换成桌面仓那套
 * （`CloudAccountSection`）；设备与座位、限时福利勾选、云端更新检查是**配对体系**的产物，
 * 桌面版没有。⛔ 不把它们塞进移植件里，避免与桌面仓同步时冲突。
 *
 * ⛔ 老壳兜底：装的是旧版云助手（preload 还没有 `cloud-auth:*` 通道）时，
 *    桌面仓那套会如实报"当前版本不支持"，此时这块就是唯一能用的入口 —— 所以它必须常显。
 */
import { useState } from "react";
import { Cloud, ShieldCheck } from "lucide-react";
import { CloudAssistantPanel } from "./CloudAssistantPanel";

export function CloudAssistantExtras() {
  const [open, setOpen] = useState(false);
  /* ⛔ 与侧栏旧入口同一道闸：独立模式（无账号服务）下不显示这块 —— 那时没有配对/座位概念。 */
  if ((window as unknown as { __CHC_ACCOUNT_GATE__?: boolean }).__CHC_ACCOUNT_GATE__ !== true) return null;
  return (
    <section className="settings-section stack cloud-acct-section" data-testid="cloud-assistant-extras">
      <div className="cloud-acct-card">
        <div className="cloud-acct-head">
          <ShieldCheck size={16} />
          <strong>云助手专属</strong>
          <span className="cloud-acct-sub">桌面版没有</span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          设备与座位（哪台机器认领了本账号）、限时福利模型勾选、云端更新检查 ——
          这些由<b>设备配对</b>决定，与上面的云账号登录是两条独立的线 —— 换号时两处都要换，
          否则座位与模型/积分可能分属两个账号。
        </p>
        <div className="cloud-acct-actions">
          <button className="secondary-setting" onClick={() => setOpen(true)}>
            <Cloud size={14} /> 打开设备与云服务设置
          </button>
        </div>
      </div>
      {open ? <CloudAssistantPanel onClose={() => setOpen(false)} /> : null}
    </section>
  );
}
