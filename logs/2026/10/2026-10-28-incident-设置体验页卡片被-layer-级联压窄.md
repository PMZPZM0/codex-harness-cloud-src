---
id: 2026-10-28-incident-设置体验页卡片被-layer-级联压窄
date: 2026-10-28
kind: incident
area: settings-ui
title: 设置体验页卡片被 @layer 级联压窄
tags: [settings, layout, css-layers]
commits: []
files: [src/styles/45-settings-experience.css, scripts/accept.mjs, scripts/guards/12ad-settings-unified.mjs]
importance: high
---

# 设置体验页卡片被 @layer 级联压窄

同步主仓：用户截图个性化页卡片只占左半。

根因：@layer 重构后全局 `.settings-section { align-items:flex-start }` 在 components 层生效，flex 纵向页面的直接子卡按内容宽收缩（page 726 / group 328）。`.settings-exp-page` 补 `align-items: stretch` 恢复满宽；验收 ⑧ 增加 groupW>=pageW-12；守卫 12ad 加一条。

判据：实测 group 722 / page 726；12ad 132/132。
