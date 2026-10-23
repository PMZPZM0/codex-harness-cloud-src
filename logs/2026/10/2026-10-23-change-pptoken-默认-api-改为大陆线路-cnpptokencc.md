---
id: 2026-10-23-change-pptoken-默认-api-改为大陆线路-cnpptokencc
date: 2026-10-23
kind: change
area: model
title: PPtoken 默认 API 改为大陆线路 cn.pptoken.cc
tags: [pptoken, endpoint, cn, provider]
commits: []
files: [src/lib/pptoken-endpoints.ts, src/features/settings-model/ModelSettingsSection.tsx, src/features/auth/LoginScreen.tsx, scripts/guards/04-misc-and-tools.mjs]
importance: normal
---

# PPtoken 默认 API 改为大陆线路 cn.pptoken.cc

# PPtoken 默认 API 改为大陆线路

## 起因
用户：ppCode 里的供应商 pptoken 默认 api 地址错了，要用国内 cn 那个。云助手同款供应商一并修正。

## 结论
- 端点表默认项改为 `https://cn.pptoken.cc/v1`（大陆优化线路）；
  国际线 `https://api.pptoken.cc/v1` 保留为第二项，US / Claude 不变。
- 供应商推荐卡、编辑表单、登录预填统一读 `PPTokenEndpoints[0].url`，不再写死 api 地址。
- 登录页 sub2api 网关保持 `api.pptoken.cc`（只改供应商 API 默认，不动账号登录链路）。
- 守卫【15】核对默认 cn 且禁止写死。

## 验证 / 影响
- 云助手 UI 需部署；预检仍余一条与本次无关的硬编码色并发红。
