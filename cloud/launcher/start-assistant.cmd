@echo off
rem Codex Harness Cloud - desktop assistant launcher (real UI, 449+ channels)
rem Any output is intentionally silent; tray icon + browser are the UX.
cd /d D:\CodexHarness-Cloud
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "CODEX_HARNESS_USER_DATA=D:\CodexHarness-Cloud\cloud\.headless-home"
set "HARNESS_CLOUD_API_KEY=harness-local-relay"
start "" "D:\CodexHarness-Cloud\node_modules\electron\dist\electron.exe" dist-electron\headless.js
timeout /t 8 /nobreak >nul
start "" "http://127.0.0.1:8917/"
