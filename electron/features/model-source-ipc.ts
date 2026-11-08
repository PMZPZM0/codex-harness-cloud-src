/**
 * model-source 域（10-15 新增；11-08 按「一个文件恒等于一个域前缀」从 `custom-model-ipc.ts` 拆出）
 *
 * 域：model-source(2)
 * 通道：model-source:get / model-source:set
 *
 * 语义：云端模型模式开关（`userData/model-source.json` 的 `cloudModels`）。
 *   开启 ⇒ 模型列表只走云端开放目录，且模型配置里本地供应商开关被锁定打不开；
 *   关闭 ⇒ 恢复本地供应商手动开关。
 *
 * ⛔ 为什么单独成域（10-03 起是硬规则，11-08 棘轮清零后不再豁免）：
 *   10-15 把它塞进 custom-model 域时留了「同文件独立前缀」的例外，那正是
 *   「一个文件恒等于一个域前缀」要禁的形态 —— 一个板块同时长着两个域的
 *   卸载 / 计数 / 登记口径，【253】的棘轮就此欠账。拆开后两边各自一个前缀。
 * ⛔ 它**不属于** custom-model：那边是「供应商档案」，这边是「来源策略」，
 *   生命周期也不同（开关关了档案仍在）。⛔ 别为了少一个文件再合回去。
 * ⛔ 与 custom-model 的唯一交互是「开关云端模式时停用本地供应商」——
 *   经 `runtime-refs` / `main` 导出的活绑定取用，⛔ 不 import 对方域模块（会成环）。
 */
import { LIMITED_BENEFIT_PROVIDER } from "./limited-benefit-ipc";
import { readModelSource, writeModelSource } from "../main/01-model-catalog";
import { readCustomModels } from "../main";
import { upsertCustomModel } from "../runtime-refs";
import { defineFeature } from "../context";
import type { IpcHost } from "../ipc-host";

const MODEL_SOURCE_CHANNELS = ["model-source:get", "model-source:set"];

export const modelSourceFeature = defineFeature<null>({
  id: "model-source",
  inject: ["ipc"],
  setup: (ctx) => {
    const ipcHost = ctx.get<IpcHost>("ipc");
    if (!ipcHost) throw new Error("model-source: 缺少 ipc 服务（宿主未提供）");

    ipcHost.handle("model-source:get", async () => readModelSource());
    ipcHost.handle("model-source:set", async (_event, input: { cloudModels: boolean }) => {
      const next = { cloudModels: Boolean(input && input.cloudModels) };
      await writeModelSource(next);
      if (next.cloudModels) {
        /* 开启云端模型模式：把**所有本地供应商**停用（限时福利那行不受影响，
           它的可用性由云端勾选决定，不占用"当前生效供应商"位）。 */
        const list = await readCustomModels();
        for (const entry of list) {
          if (entry.provider !== LIMITED_BENEFIT_PROVIDER && entry.enabled !== false) {
            await upsertCustomModel({ ...entry, enabled: false });
          }
        }
        console.log(`[model-source] 已开启云端模型模式：停用 ${list.filter((e) => e.provider !== LIMITED_BENEFIT_PROVIDER).length} 个本地供应商`);
      } else {
        console.log("[model-source] 已关闭云端模型模式（本地供应商开关解锁，可手动重新启用）");
      }
      return readModelSource();
    });

    /* 卸载时摘掉本域通道（与 custom-model 同口径：⛔ 别让重挂载留下两套 handler）。 */
    ctx.effect(() => {
      for (const ch of MODEL_SOURCE_CHANNELS) ipcHost.removeHandler(ch);
    });
  },
});
