/**
 * 限时福利域（limited-benefit）判据（10-14 立）
 *
 * 用户报障：「没自动生成 apikey 嘛，好像用不了」。
 * 实测根因**不是** key 没生成，而是**令牌轮换后 key 没被同步** —— 供应商行与生效档案里
 * 留着上一枚已作废的令牌，引擎拿它调上游静默 401，而界面照旧显示
 * 「API Key 已安全保存，留空则不修改」（看着一切正常，用户只觉得用不了）。
 *
 * 两处根因（都在 electron/features/limited-benefit-ipc.ts）：
 *   ① applyProvider 写行的判据只看「行里有没有 encryptedKey」，不看「令牌有没有变」
 *      ⇒ 令牌轮换（重签 / 换绑 / 服务端清记录）后 apply 依旧沿用旧 key；
 *   ② promoteIfVacant 在「已经是自己」时裸 return false
 *      ⇒ 生效档案（custom-model.json）的 key 永远刷不新。
 *
 * 失效方式全是有害且静默的：调用 401 但界面显示一切正常。
 * 行为（真实调用）由实测覆盖（10-14 已实测：本机桥 47121 → 云端代理 → hy4-preview 返回 OK）；
 * 本守卫钉**结构**，防止这两处回退成裸判据。
 * 独立守卫（不进 _ctx MODULES 计数），要加进 package.json 的 check 链。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./_ctx.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let checks = 0;
let fails = 0;
const ok = (condition, message) => {
  checks++;
  console.log(`  ${condition ? "✓" : "✗"} 【limited-benefit】${message}`);
  if (!condition) fails++;
};

const domain = codeOnly(read("electron/features/limited-benefit-ipc.ts"));
const manifest = read("electron/ipc-channels.manifest.json");
const registry = read("electron/ipc-registry.ts");
const composition = read("electron/composition.json");

/* ① 令牌轮换必须同步供应商行 —— 本次根因，最核心一条。 */
ok(/decryptRowKey\s*\(/.test(domain) && /const keyStale\s*=/.test(domain) && /token\s*!==\s*prevKey/.test(domain),
  "applyProvider 必须把「行内 key」解出来与最新令牌比对（keyStale）—— 只看「有没有 key」会在令牌轮换后沿用失效凭据");

/* 同一个判据要参与「要不要重写」的决定，否则检测出来了也不写。 */
ok(/previous\?\.encryptedKey\s*&&\s*!keyStale/.test(domain),
  "已有 key 且令牌未变才沿用原值（keyStale 时必须重写，否则 apply 修不好失效凭据）");

/* ② 已是生效位也要看 key —— 本次根因二。 */
ok(!/===\s*row\.provider\)\s*return false/.test(domain),
  "promoteIfVacant 不得在「已是自己」时裸 return false（那样生效档案的 key 永不刷新）");
ok(/===\s*row\.provider\s*&&\s*active\.encryptedKey\s*===/.test(domain),
  "promoteIfVacant 的「已是自己」判据必须与 key 比较连用（key 变了就得重写 + 重新下发引擎）");

/* ③ 与云账号共存（10-28）：云端供应商占生效位时不得把自己重新置为启用 ——
   两个绿开关 + 云侧互斥下一个周期又关掉 = 开关来回闪。 */
ok(/cloudOwnsSeat/.test(domain) && /enabled:\s*cloudOwnsSeat\s*\?\s*false/.test(domain),
  "云供应商生效时限时福利不得把自己重新置为启用（enabled 判据含 cloudOwnsSeat）");

/* 凭据边界：行里只许落加密值，绝不写明文。 */
ok(/function encryptToken/.test(domain) && /encryptedKey:\s*token\s*\?\s*encryptToken\(token\)/.test(domain),
  "供应商行凭据只经 encryptToken 写入（不写明文；加密不可用时宁可不写）");
ok(/isEncryptionAvailable\(\)/.test(domain),
  "加密可用性必须先判（safeStorage 不可用时不得退化成写明文）");

/* 接线：四条通道登记齐全，域已挂载（漏登记 ⇒ 通道调不到 / 域不挂载）。 */
const CHANNELS = ["limited-benefit:catalog", "limited-benefit:token", "limited-benefit:status", "limited-benefit:apply"];
ok(CHANNELS.every((c) => manifest.includes(`"${c}"`)), "四条通道全在 ipc-channels.manifest.json");
ok(CHANNELS.every((c) => registry.includes(`"${c}"`)) && /prefix:\s*"limited-benefit",\s*count:\s*4/.test(registry),
  "ipc-registry.ts 登记四条通道且 count=4（改通道数要同步这个数字）");
ok(/"id":\s*"limited-benefit"/.test(composition), "域在 composition.json 挂载");

console.log(`\n【limited-benefit】${checks - fails}/${checks} 通过${fails ? ` —— ${fails} 条红` : ""}`);
if (fails) process.exitCode = 1;
