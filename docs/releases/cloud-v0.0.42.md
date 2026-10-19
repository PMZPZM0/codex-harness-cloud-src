# cloud-v0.0.42

## 本版把一个长期存在的冲突修掉了：云助手和标准版是同一个应用身份

**现象**：同一台机器上装完 Codex Harness Desktop 再装云助手，后者会**覆盖**前者；反过来一样。两个产品只有一个能留下。

**根因**：`package.json` 里两边的标识完全一样：

| 字段 | 云助手（本版前） | 标准版 |
|---|---|---|
| `build.productName` | `Codex Harness Desktop` | `Codex Harness Desktop` |
| `build.appId` | `com.codexharness.desktop` | `com.codexharness.desktop` |

- **Windows**：同一个 NSIS 安装目录 + 同一个 appId（即同一个安装 GUID）⇒ 后装的直接覆盖先装的
- **macOS**：同一个 `.app` 名字 ⇒ 拖进「应用程序」时互相替换

**修法**：

```json
"productName": "Codex Assistant"
"appId":       "com.codexharness.assistant"
```

改完之后：

- 两个 app 可以**共存**，安装目录、注册表项、AUMID、userData 全部独立
- macOS 上是 `Codex Assistant.app`，`xattr` 命令变成 `xattr -cr "/Applications/Codex Assistant.app"`
- 更新器按各自的仓走，不会互相干扰

## 顺带修掉一个从未生效的钩子

`build/installer.nsh` 里写着：

```nsis
nsExec::ExecToStack 'taskkill /F /T /IM "Codex Harness Assistant.exe"'
```

但 `productName` 一直是 `Codex Harness Desktop`，**进程名从来不是 `Codex Harness Assistant.exe`** ⇒ 这个「安装前先关掉已运行的实例」的钩子**从未杀到过任何进程**。

本版把进程名改为 `Codex Assistant.exe`，与新 `productName` 一致，钩子第一次真正生效。

> ⚠️ 副作用：升级到本版后，桌面/开始菜单会同时出现**旧的** `Codex Harness Desktop` 和**新的** `Codex Assistant` 两个入口。旧的那个是上版本的残留，手动删掉即可（它指向的程序已被本版替换，双击会启动云助手）。

## mac 首次打开

未做 Apple 公证，首次打开会被 Gatekeeper 拦。打开「终端」，把应用图标拖进去（自动补全路径），在路径前加 `xattr -cr ` 回车：

```bash
xattr -cr "/Applications/Codex Assistant.app"
```

只需一次，升级后不用重复。

## 已知问题

- 旧版遗留的 `Codex Harness Desktop` 快捷方式/应用需要手动清理（见上一节）。
- 云端界面与桌面壳是两条更新线：界面改动走自更新（`manifest.json`），壳改动才需要重装。
