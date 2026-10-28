/**
 * 设置页 · 云账号（云助手）—— 桌面仓云账号板块的**唯一挂载点**（10-28 自桌面仓移植）。
 *
 * ⛔ `CloudAccountSection` 保持与桌面仓逐字一致（品牌无关、自包含），
 *   云助手独有的三块（设备/座位、限时福利、云端更新）放在它下面的 `CloudAssistantExtras`，
 *   不往移植件里加分支 —— 否则以后同步桌面仓会两处打架。
 *
 * ⛔⛔ **旧壳兜底**：界面是部署在服务器上的，本机壳（preload）可能还是旧版、没有 `cloud-auth:*`。
 *   桌面仓那套会停在「读取中…」，看起来像坏了 ⇒ 这里按能力探测换成一句明确的说明，
 *   并把云助手专属入口照常留着（配对体系不依赖新通道）。
 */
import { Cloud } from "lucide-react";
import { CloudAccountSection } from "./CloudAccountSection";
import { CloudAssistantExtras } from "./CloudAssistantExtras";

function hasCloudAccountApi(): boolean {
  const api = (window as unknown as { codex?: { cloudAuthStatus?: unknown } }).codex;
  return typeof api?.cloudAuthStatus === "function";
}

export function CloudAccountPage() {
  const supported = hasCloudAccountApi();
  return (
    <>
      {supported ? (
        <CloudAccountSection />
      ) : (
        <section className="settings-section stack cloud-acct-section" data-testid="cloud-account-unsupported">
          <div className="cloud-acct-card">
            <div className="cloud-acct-head">
              <Cloud size={16} />
              <strong>云账号</strong>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              当前安装的云助手版本较旧，还没有云账号通道。请先更新应用（头像菜单 →「检查更新」），
              更新后这里会出现登录与一键配齐模型 / 云端知识库 / 云端记忆。
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              设备与座位、限时福利、云端更新由设备配对决定，不受这次更新影响。
            </p>
          </div>
        </section>
      )}
      <CloudAssistantExtras />
    </>
  );
}
