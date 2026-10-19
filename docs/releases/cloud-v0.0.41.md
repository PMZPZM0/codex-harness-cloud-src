# cloud-v0.0.41

## 本版修的两个发版链路缺陷

### 1. 版本号被硬编码，所有包都覆盖到同一个 Release

**现象**：每次发版后，`cloud-v0.0.8` 那个旧 Release 的资产会被**新版本的包覆盖**，而新 tag 对应的 Release 根本不存在。

**根因**：`release-cloud.yml` 的 `env` 里写死了：

```yaml
ASSISTANT_VERSION: "0.0.8"
```

三个 job（win / mac arm64 / mac intel）都用它拼 tag，于是**无论推什么 tag，上传目标恒为 `cloud-v0.0.8`**，且 `--clobber` 直接覆盖。

**修法**：版本号从 tag 取 —— `VERSION="${GITHUB_REF_NAME#cloud-v}"`（`cloud-v0.0.41` → `0.0.41`）。

### 2. mac x64 用了已退役的 runner，发版永久排队

**现象**：`cloud-v0.0.39` 从触发起 **queued 11 小时**没拿到机器。

**根因**：mac 矩阵写的是 `macos-13`（GitHub 已退役该镜像）。而 `build-mac.yml` 里早已改成 `macos-15-intel`——`release-cloud.yml` 内联了自己的一份，没跟着改。

**附带问题**：`concurrency` 用固定组名 + `cancel-in-progress: false`，一次卡死的 run 会**永久堵住**后续所有发版。

**修法**：
- `macos-13` → `macos-15-intel`
- `concurrency.group` → `release-cloud-${{ github.ref_name }}`（每个 tag 独立）

## mac 说明

未做 Apple 公证，首次打开会被 Gatekeeper 拦。打开「终端」，把应用图标拖进去（自动补全路径），在路径前加 `xattr -cr ` 回车：

```bash
xattr -cr "/Applications/Codex Harness Desktop.app"
```

只需一次，升级后不用重复。

## 已知问题

- 旧版 `cloud-v0.0.8` 的 Release 资产已被本版之前的错误上传覆盖，**内容与标签不一致**；请以下载页显示的版本为准。
- 云端界面（`ppz123.asia`）与桌面壳是两条更新线：界面改动走自更新（`manifest.json`），壳改动才需要重装。
