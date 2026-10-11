; Codex Harness Assistant（云助手）自定义 NSIS 安装钩子（10-11）
; ⛔⛔ preInit（早于模板的运行中检查）：覆盖安装时助手在跑（托盘「关闭窗口=最小化到
;   托盘」吞掉 AppAlive 的 WM_CLOSE）⇒ 安装器弹「无法关闭，请手动关闭它」并停住。
;   按进程名强杀（含 /T 子进程树）；⚠️ 应用以管理员权限运行时，非提权安装器杀不动
;   → 右键「以管理员身份运行」安装器。
!macro preInit
  DetailPrint "正在关闭已运行的 Codex Harness Assistant…"
  nsExec::ExecToStack 'taskkill /F /T /IM "Codex Harness Assistant.exe"'
  Pop $0
  Pop $1
  Sleep 800
!macroend

!macro customInstall
  DetailPrint "内置工具：Node / Python / rg 等首次使用时按需下载（国内镜像优先）"
!macroend