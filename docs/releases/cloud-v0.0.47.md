# cloud-v0.0.47 发版说明（Codex Assistant 云助手）

本版主题：**修掉 mac 上「安装免费网关」必失败；云管理随服务端升到 1.5.65。**

> 版本号说明：云助手壳此前包内版本停在 `0.0.8`，而 tag 已到 `cloud-v0.0.46` —— 两者长期不一致
> （用户看到的「已装版本」与发布页对不上）。本版把 `electron-builder.assistant.yml` 的
> `extraMetadata.version` 对齐到 `0.0.47`，从此 tag 与包内版本同源。

## 一、改了什么

### 1. mac：免费网关解压器（真缺口，已修）
云助手与桌面版共用同一个「免费网关」域。它的 zip 解压写死了 Windows 的 `7za.exe`，
而 darwin 随包的是 7-Zip 官方 **`7zz`**（`scripts/install-runtimes.cjs` 的 sevenzip marker 就是 `7zz`）
⇒ **mac 上「安装免费网关」必失败**（找不到或不可执行）。

现按平台取名（Windows `7za.exe` / 其它 `7zz`），命令行参数不变（`x -o<dir> -y`）。

### 2. 云管理页面随服务端升到 1.5.65（不需要重装云助手）
云助手窗加载的是服务器上的页面（`/cloud/app/`），这几项你在网页上刷新就能看到，与新装包无关：
- 控制台 / 登录页的品牌 logo 改成与应用同一张图标（客户机 PP 图标、主站 Codex Harness 图标）
- 产品首页重做（深色 hero 横幅 + 三平台下载卡 + 特色网格 + 更新时间线）
- 知识库 / 记忆中心新增「到期自动清理」开关（可只提醒、不删资源）

### 3. mac 适配审计结论
`node scripts/mac-audit.mjs cloud-v0.0.46 HEAD`：命中 **74 条**，逐条判读后 **1 处真缺口（即上面的 7za）已修**。
其余命中：`toolchain.ts` 的 `C:\Program Files` 与 `%USERPROFILE%` 在 `win32` 分支内；
`dev-runtimes` 的 `python.exe + DLLs\_tkinter.pyd` 在 `IS_MAC` 的 else 分支；
`remote.ts` 的 cloudflared 已按平台解析并认 `/opt/homebrew/bin`；`ctrl-key` 为 `ctrlKey || metaKey`；
`backslash` 集中在验收脚本与路径归一；`powershell` 是给模型的说明文本。

## 二、mac 首次打开自救（带路径）

未做 Apple 公证，首次打开会被 Gatekeeper 拦。打开「终端」，**把应用图标拖进终端窗口**（自动补全路径），
在路径前加 `xattr -cr ` 回车：

```bash
xattr -cr "/Applications/Codex Assistant.app"
```

只需一次，升级后不用重复。若提示 **错误 640**，是同样的 quarantine 属性，执行上面的命令后重开即可。

## 三、已知问题

- 免费网关的 mac 修复只做了平台分支复核，无 mac 真机回归。
- 云助手的「云管理页面」内容跟随服务器版本（1.5.65），与本安装包版本是两条线，不要用包版本判断页面新旧。
