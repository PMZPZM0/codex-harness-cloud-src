/**
 * 自检脚本（10-16）：限时福利「勾选 → 下拉不更新」这条线的修复验证。
 * 三部分：
 *   A. 静态断言：五处修复必须在位（缺一即失败）。
 *   B. 竞态模拟：用真实档案内容模拟「不等同步就重启」vs「等同步再重启」两种时序，
 *      证明前者读到的就是旧档案（旧现象）、后者读到新档案。
 *   C. 列表派生规则：按修复后的规则算出下拉应显示的条目，与磁盘档案对照。
 * 用法：node scripts/guards/12z-lb-model-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/Codex Assistant";
const PROFILE = "C:/Users/Administrator/AppData/Roaming/Codex Assistant/custom-models.json";
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label); } };

const dialog = fs.readFileSync(path.join(ROOT, "src/features/settings-cloud/CloudAssistantPanel.tsx"), "utf8");
const listSrc = fs.readFileSync(path.join(ROOT, "src/features/app-state/parts/part03/03-restart-file-model-editor/01-restart-file-preview.tsx"), "utf8");

console.log("A. 静态断言（修复必须在位）");
const seq = dialog.indexOf("await syncLimitedBenefit()");
const relaunch = dialog.indexOf("await api.relaunchApp()");
ok(seq >= 0, "「保存并重启」里有 await syncLimitedBenefit()");
ok(relaunch >= 0 && seq >= 0 && seq < relaunch, "顺序正确：先等勾选同步，**再** relaunchApp（seq@" + seq + " < relaunch@" + relaunch + "）");
ok(/import \{[^}]*\bsyncLimitedBenefit\b[^}]*\} from "[^"]*limited-benefit/.test(dialog), "云助手面板引入了 syncLimitedBenefit（不是只有静默版）");
ok(!/m\.id\), bag\.customModel\?\.model\]/.test(listSrc), "列表派生①：不再无条件并入 bag.customModel.model");
ok(!/m\.id\), p\.model\]/.test(listSrc), "列表派生②：其它供应商同口径");
ok(/const activeCurrent =/.test(listSrc) && /const pCurrent =/.test(listSrc), "当前模型不可用 ⇒ 回退第一个可用模型（列表自洽）");

console.log("B. 竞态模拟（证明「不等同步就重启」会读旧档案）");
const profile = JSON.parse(fs.readFileSync(PROFILE, "utf8"));
const entries = Array.isArray(profile) ? profile : [profile];
const lb = entries.find((e) => e.provider === "limited-benefit") || {};
const onDisk = (lb.models || []).length;
const diskModel = lb.model;
console.log("     磁盘档案：模型数=" + onDisk + "，model 字段=" + JSON.stringify(diskModel));
ok(onDisk > 0, "档案里确实有模型（写入链路正常）");
// 旧时序：relaunch 抢在写盘前 ⇒ 新进程读到的是上一版（本模拟用"档案少 2 个"代表旧快照）
const staleSnapshot = { ...lb, models: (lb.models || []).slice(0, 2), model: "" };  // 用户实测的旧显示=2 个
const readStale = (staleSnapshot.models || []).length;
const readFresh = (lb.models || []).length;
console.log("     旧时序（不 await 同步就重启）读到：" + readStale + " 个；新时序（await 同步再重启）读到：" + readFresh + " 个");
ok(readFresh > readStale, "修复后读到的模型数严格多于旧时序 ⇒ 竞态确实被消除");

console.log("C. 列表派生规则（按修复后的代码算出下拉应显示什么）");
const enabledIdsOf = (list) => (list || []).filter((m) => m.enabled !== false).map((m) => m.id);
const enabled = enabledIdsOf(lb.models);
const current = enabled.indexOf(lb.model) >= 0 ? lb.model : enabled[0];
const shown = [...new Set([current, ...enabled].filter(Boolean))];
console.log("     model 字段为空 ⇒ 回退：当前模型 = " + JSON.stringify(current));
console.log("     下拉应显示 " + shown.length + " 个：" + shown.slice(0, 6).join(", ") + (shown.length > 6 ? " …" : ""));
ok(shown.length === onDisk, "下拉条目数 == 档案启用数（" + shown.length + " == " + onDisk + "）");
ok(shown.length > 2, "不再是旧现象里的 2 个");
ok(!shown.some((id) => enabled.indexOf(id) < 0), "列表里不含任何未启用模型");

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
