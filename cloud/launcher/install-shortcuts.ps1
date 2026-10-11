# Codex Harness Cloud · 把「小助手」装成桌面应用（快捷方式 + 图标）
#
#   powershell -ExecutionPolicy Bypass -File launcher\install-shortcuts.ps1
#   powershell -ExecutionPolicy Bypass -File launcher\install-shortcuts.ps1 -Startup   # 顺带开机自启
#   powershell -ExecutionPolicy Bypass -File launcher\install-shortcuts.ps1 -Remove    # 卸载快捷方式
#
# 做什么：
#   ① 把 launcher/dist/CodexHarnessCloud.exe 复制到 %LOCALAPPDATA%\CodexHarnessCloud\
#      —— ⛔ 不直接把快捷方式指到代码副本里：那个目录会移动/被删，快捷方式就成死链了。
#   ② 把「本机引擎在哪」写进 ~/.codex-harness-cloud/config.json
#      —— exe 的 cwd 是快捷方式决定的，不写死就只能靠运气找到引擎。
#   ③ 建桌面 + 开始菜单快捷方式（用 exe 自带的图标），双击即：起服务 → 自动开浏览器。
#
# ⛔ 这脚本需要 COM（WScript.Shell）才能建 .lnk —— 沙箱里会被拦，需在正常用户环境跑。

param(
  [switch]$Startup,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudDir = Split-Path -Parent $here
$srcExe = Join-Path $here "dist\CodexHarnessCloud.exe"

$appDir = Join-Path $env:LOCALAPPDATA "CodexHarnessCloud"
$dstExe = Join-Path $appDir "CodexHarnessCloud.exe"

$desktop = [Environment]::GetFolderPath("Desktop")
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$startupDir = [Environment]::GetFolderPath("Startup")

$shortcutName = "Codex Harness Cloud"

function Remove-Shortcuts {
  foreach ($p in @(
    (Join-Path $desktop "$shortcutName.lnk"),
    (Join-Path $startMenu "$shortcutName.lnk"),
    (Join-Path $startupDir "$shortcutName.lnk")
  )) {
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "[卸载] 已删除 $p" }
  }
}

if ($Remove) {
  Remove-Shortcuts
  Write-Host "[卸载] 完成（%LOCALAPPDATA%\CodexHarnessCloud 里的程序保留，要删自己删）"
  exit 0
}

if (-not (Test-Path $srcExe)) {
  Write-Host "[安装] 找不到 $srcExe" -ForegroundColor Red
  Write-Host "[安装] 先打包：cd `"$cloudDir`" ; node launcher\build-exe.mjs" -ForegroundColor Yellow
  exit 1
}

# ① 复制到用户目录（版本变了就覆盖）
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
$needCopy = $true
if (Test-Path $dstExe) {
  $needCopy = (Get-Item $srcExe).Length -ne (Get-Item $dstExe).Length
}
if ($needCopy) {
  Copy-Item $srcExe $dstExe -Force
  Write-Host "[安装] 已安装程序 → $dstExe"
} else {
  Write-Host "[安装] 程序已是最新（大小一致），跳过复制"
}

# ② 把引擎位置写进配置（这样 exe 在任何工作目录都能找到引擎）
$home2 = if ($env:HARNESS_CLOUD_HOME) { $env:HARNESS_CLOUD_HOME } else { Join-Path $env:USERPROFILE ".codex-harness-cloud" }
New-Item -ItemType Directory -Force -Path $home2 | Out-Null
$cfgPath = Join-Path $home2 "config.json"
$cfg = @{}
if (Test-Path $cfgPath) {
  try { $cfg = (Get-Content $cfgPath -Raw | ConvertFrom-Json) | ConvertTo-Json -Depth 6 | ConvertFrom-Json } catch { $cfg = @{} }
}

# 引擎二进制候选：旁边的工作副本 → 环境变量
$engineCandidates = @(
  (Join-Path $cloudDir "node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"),
  (Join-Path (Split-Path -Parent $cloudDir) "node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"),
  "D:\Codex Harness Desktop\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
)
$engine = $engineCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($engine) {
  if (-not $cfg.engine) { $cfg | Add-Member -NotePropertyName engine -NotePropertyValue ([pscustomobject]@{}) }
  $cfg.engine = [pscustomobject]@{ binary = $engine; codexHome = (Join-Path $env:USERPROFILE ".codex") }
  Write-Host "[安装] 引擎 → $engine"
} else {
  Write-Host "[安装] 没找到 codex 引擎二进制（先用 npm run start:mock 也能看界面）" -ForegroundColor Yellow
}
$cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Host "[安装] 配置 → $cfgPath"

# ③ 建快捷方式（COM）
$shell = New-Object -ComObject WScript.Shell
function New-Lnk([string]$lnkPath) {
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $dstExe
  $lnk.WorkingDirectory = $appDir
  # 图标取自 exe 自己（打包时已用 rcedit 换成产品图标）
  $lnk.IconLocation = "$dstExe,0"
  $lnk.Description = "启动本机伴生服务并打开 Codex Harness Cloud 界面"
  $lnk.WindowStyle = 7   # 最小化启动：不糊一脸黑框，但任务栏留一个可关的窗口
  $lnk.Save()
}

New-Lnk (Join-Path $desktop "$shortcutName.lnk")
Write-Host "[安装] 桌面快捷方式 → $(Join-Path $desktop "$shortcutName.lnk")"
New-Lnk (Join-Path $startMenu "$shortcutName.lnk")
Write-Host "[安装] 开始菜单 → $(Join-Path $startMenu "$shortcutName.lnk")"

if ($Startup) {
  New-Lnk (Join-Path $startupDir "$shortcutName.lnk")
  Write-Host "[安装] 开机自启 → $(Join-Path $startupDir "$shortcutName.lnk")"
}

Write-Host ""
Write-Host "[安装] 完成。双击桌面的「$shortcutName」即可：" -ForegroundColor Green
Write-Host "         起本机伴生服务 → 自动打开浏览器 → 进入界面"
Write-Host "         关掉那个最小化的窗口 = 停止本机服务。"
