# cloud-v0.0.55 发版说明

本版主题：**自媒体工作台 + MOSS 语音全家桶 + 记忆原子体系，三仓同轮发布（云侧同源）。**

> **版本号与文件命名说明（必读）**：云助手走自己的 `cloud-v*` tag 线，本仓唯一发布流水线
> 是 `.github/workflows/release-cloud.yml`（tag `cloud-v*` 触发）。它按
> `NOTES="docs/releases/${TAG}.md"` 取正文，因此**本文件必须叫 `cloud-v0.0.55.md`**，
> 不是 `v0.0.55.md`（`cloud-v0.0.53` 上传失败就是这个根因，已由 `f1ae7769` 修掉）。
> 仓库里的 `release.yml` 是已停触发的遗留副本，⛔ 不再由 tag 触发，避免两条流水线
> 往同一个 Release 传不同名字的资产。同期主仓发 `v0.0.57`、PPcode 发 `v0.1.13`。

## 一、修了什么（按用户感知排序）

### 1. 自媒体工作台（新独立板块）
- 原样嵌入开源 dsh-media-desk（MIT）界面，配 Codex 全流程工具：素材、风格到成稿一次跑通。
- 入口挪到侧栏「工作伙伴」下方，改成**独立窗口**；风格页网格自适应，去掉空列。
- 补齐 DSH 宿主主题变量，修掉「整页全透明看不见 / 按键点不了」；生图默认复用内置生图插件。
- 工作台页补开源声明与「开源项目」跳转。

### 2. MOSS 语音
- MOSS-Live 远程实时语音模型接入，按官方协议重写并实测打通。
- MOSS-TTS 播报 + 卡片弹窗配置、音色试听；Codex 可用 list/set 工具自选音色，播报语速可调。
- MOSS 委派接通 Codex 并隐藏注入提示词；审查修正密钥脱敏、委派取消语义、注入剥离同源。

### 3. 记忆原子体系（本仓本轮深度合并）
- 上一轮把主仓记忆原子 / 群聊闭环 / 产物归档 / 四板块工具条按「与基线的四种关系」
  并入本仓（84 个文件），并保留 21 个 `cloud:*` / `limited-benefit:*` / `model-source:*` /
  `updates:*` 定制通道与登录门；生成物只并通道级差分后由本仓自己重跑生成器。
- 记忆改按条（原子）存取、按群分层，支持精确作废、搜索清选择；产物统一进归档页。
- 语音委派新开的工作会话补 `ensureProjectAgentsMd`，项目说明不再丢失（三仓同修）。

### 4. 主题与 CLI 同步
- 主题扩到白天 4 套 / 黑夜 4 套，主题色白天、黑夜各 5 套可定制。
- 「同步给 CLI」面板整体重排、逐项回执、切供应商后可手动补同步，状态挂每行右侧。

### 5. 稳定性与流水线
- 修掉发送任务时的 TLS 原生闪退；发布步骤不再被卡死的 Intel mac 打包阻断。
- **修打包版本漂移**：`electron-builder.assistant.yml` 的 `extraMetadata.version` 一直停在
  `0.0.50`，而 tag 已发到 `cloud-v0.0.54` ⇒ 包内 `app.getVersion()` 与发布版本不一致，
  更新器会反复认为「有新版」。本版对齐到 `0.0.55`。

## 二、mac 适配审计结论

`node scripts/mac-audit.mjs cloud-v0.0.54 HEAD`：**命中 10 条**。步骤 1 的 8 条正则全部
通过人造样本自证，因此 0 命中的分类是「真的没有」，不是正则失效。

| 分类 | 命中 | 判读 |
|---|---|---|
| `exe` | 1 | 平台门控 / 错误文案内的 Windows 可执行文件字样，非写死工具路径 |
| `win32` | 2 | 平台判断在门控内；`darwin` 反向检查同时有 1 条，未漏 mac 分支 |
| `darwin` | 1 | mac 分支存在 |
| `backslash` | 6 | 文件名非法字符清洗（正则同时含 `\` 与 `/`）与断言夹具；`atoms-select.ts` 的 `replace(/\\/g, "/")` 是跨平台路径归一化 |
| `winpath` / `powershell` / `appdata` / `ctrl-key` | 0 / 0 / 0 / 0 | 无硬编码 Windows 绝对路径、无 PowerShell 依赖、无 APPDATA 直取、快捷键走 `ctrlKey \|\| metaKey` |

**结论：逐条判读后，本版新增逻辑无 mac 真缺口。**

## 三、mac 首次打开自救（带路径）

1. 在「下载」里**双击解压** zip；
2. 把 `Codex Assistant.app` **拖进「应用程序」**；
3. 第一次被拦时，**把图标拖进「终端」窗口** —— 终端会自动填出完整路径（不用自己敲）；
4. 在填出的路径前加 `xattr -dr com.apple.quarantine `（后跟一个空格）再回车；
5. 报 **错误 640** 时改用系统「归档实用工具」重新解压再放行。

## 四、组件版本体检与名称 / 打包 / 发版核对结论

按发版技能 §1.5，体检覆盖全部 `dependencies` + `devDependencies`；「是否最新」只认
npmjs 官方 `dist-tags`，⛔ 不拿镜像缓存快照当判据。

| 面 | 结论 |
|---|---|
| 引擎 `@openai/codex` | `0.167.0` → **`0.167.1`**（官方 latest）；三仓均已核 `node_modules` 实装版 |
| `lucide-react` / `vite` | `1.71.0` → **`1.72.0`** / `8.3.7` → **`8.3.8`**；三仓各自更新 lock，声明范围不变 |
| 内置 `open-computer-use` | `1.1.4` = 官方 latest，保持 |
| 内置 `nuphus` | `0.3.4`；`build-mac.yml` 的 `ref: v0.3.4` 与 `tools-versions.cjs` 一致，保持 |
| `tsparticles` 组 | **保持 `4.5.3`**：升 4.5.4 触发 `ETARGET`（`@tsparticles/plugin-emitters@4.5.4` 未发布），按技能不硬糊依赖树 |
| `electron` | **保持本仓 `45.2.3`**：升级撞 `EBUSY`（运行中实例锁住 `node_modules/electron/dist`），且跨大版本需 ABI 与真机验证 |
| `typescript` | **保持 `6.0.3`**：`@typescript-eslint/parser` peer `<6.1.0`，`7.0.2` 会 `ERESOLVE`，不用 `--legacy-peer-deps` |
| 按需安装工具 | `feishuCli` / `filee` / `rea` / Ego Lite 不在本轮更新面；云助手本来就是「精简包 + 工具链按需下载」 |
| 名称 | `Codex Assistant` / `com.codexharness.assistant` / `extraMetadata.name = codex-assistant`（独立 userData、独立安装目录、独立 AUMID）；沿用桌面版品牌，不是第三套 |
| 打包 | 本仓**自己** `npm run build` + `electron-builder --config electron-builder.assistant.yml`；`dist/assets/index-*.css` mtime ≥ `src/styles/01-base-and-chrome.css`；`extraMetadata.version` 已对齐 `0.0.55` |
| 发版 | tag `cloud-v0.0.55`；`VERSION` 由 CI 从 tag 取，资产名 `CodexHarnessAssistant-0.0.55-*`；本文件存在；`whats-new-notes.ts` 最新条目 `0.0.55` |
| 云端界面 | 本仓 `src/**` 改动须 `node scripts/deploy-cloud-ui.mjs` 部署到服务器，本机 `dist` 不直接生效；本轮已部署并校验入口哈希与 `protocolVersion=1` |

## 五、已知问题

- `tsparticles` 生态 4.5.4 子包尚未发齐，本版保留 4.5.3（不影响功能）。
- `electron` / `typescript` 的跨大版本升级需另起一轮做 ABI 与真机验证，本版未纳入。
- **【265】行数棘轮已按守卫实测口径记账**（`11z-voice-call` 1232 /
  `voice-service` 1036 / `vite-env.d.ts` 1118 / `dispatch-rpc` 1007），复验「变长：无」。
- ⚠️ **副本仓遗留（非本轮回归）**：`12q-cloud-account` 首启登录页 3 条断言写死了
  主仓 `mode` 五选项 + `login-option-title` 的 DOM 字面量；本仓走独立登录门
  （`__CHC_ACCOUNT_GATE__`）另一套形态，PPcode 则是 `method` 两选项 tab 的等效实现。
  属仓间产品差异，不是功能回归；是否统一登录页形态需单独确认，本版未改动可见交互。
- 其余门禁结论以本轮 `npm run check` 末尾总账为准；本轮已清掉 5 类被 `&&` 链
  断裂长期掩盖的红项（详见提交信息）。
