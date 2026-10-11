/**
 * Codex Harness Cloud · 界面走查（Electron 主进程侧）
 *
 * 由 scripts/shot.mjs 拉起，不要直接跑。
 *
 * 为什么用 Electron 自己渲染：这台机器没有可交互的桌面会话，但 Electron 能在
 * `show:false` 的窗口里把真实 Chromium 的渲染结果 `capturePage()` 出来 —— 验的是
 * **真浏览器的真样式**，不是"看代码猜"。几个必须的开关（都是踩出来的）：
 *   · `disableHardwareAcceleration()` + `in-process-gpu` —— 否则离屏渲染在这台机器上直接崩 GPU
 *   · `env -u ELECTRON_RUN_AS_NODE` —— 否则 electron.exe 会退化成一个 node 进程
 *   · 截图窗口高度不能超过虚拟屏幕，超了会被裁（本脚本先用 860，不追求整页长图）
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

/**
 * ⛔⛔ 配置一律走**环境变量**，命令行只留 `electron.exe <开关> <脚本>`。
 *   本机实测：给 Electron 追加任何 argv（哪怕只是一个 `--label p`）都会让启动变成
 *   大概率失败 —— 进程在**主脚本执行之前**就退出（exit 127，日志文件都不会被创建），
 *   而同样的脚本不带参数跑则次次成功。原因没查到底（Chromium 的 argv 解析在这个沙箱里
 *   似乎会被拦），但"不带多余参数"这条规律在所有成功案例上零反例，所以照它写。
 */
function arg(name, fallback) {
  const envKey = `SHOT_${name.toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey];
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const URL_TARGET = arg("url", "http://127.0.0.1:8917/");
const OUT_DIR = arg("out", path.join(__dirname, "..", "docs", "shots"));
const LABEL = arg("label", "ui");
const WIDTH = Number(arg("width", 1280));
const HEIGHT = Number(arg("height", 860));

fs.mkdirSync(OUT_DIR, { recursive: true });
const LOG_FILE = path.join(OUT_DIR, `${LABEL}-log.txt`);
try { fs.writeFileSync(LOG_FILE, ""); } catch { /* 忽略 */ }
/**
 * ⛔⛔ Windows 上 Electron 是 GUI 进程，**stdout/stderr 不接父进程的管道** ——
 *   console.log 和未捕获异常都会凭空消失（第一次跑走查就是这样：exit=-1、零输出，
 *   完全不知道发生了什么）。所以这里一律**落盘**，由 shot.mjs 在进程退出后回读打印。
 */
function log(line) {
  try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* 忽略 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { steps: [], probe: {} };

async function waitForJs(win, expression, timeoutMs = 12_000, label = expression) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = await win.webContents.executeJavaScript(expression); } catch { value = false; }
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(120);
  }
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  report.steps.push({ name, size });
  log(`[shot] ${name} ${size.width}x${size.height}`);
}

const click = (win, selector) => win.webContents.executeJavaScript(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`);

/** 就绪失败时的现场快照：资产从哪来、外壳说了什么、正文里有没有东西。 */
async function diagnose(win) {
  try {
    const info = await win.webContents.executeJavaScript(`(() => {
      const script = [...document.querySelectorAll("script[src]")].map((s) => s.src);
      const link = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href);
      return JSON.stringify({
        url: location.href,
        readyState: document.readyState,
        chcReady: window.__chcReady === true,
        hasShellGlobal: typeof window.__CHC_SHELL__,
        scripts: script,
        styles: link,
        bootSub: document.getElementById("boot-sub")?.textContent || null,
        bootErr: document.getElementById("boot-err")?.textContent || null,
        appPresent: Boolean(document.querySelector(".app")),
        bodyChildren: document.body.children.length,
      }, null, 2);
    })()`);
    return info;
  } catch (error) {
    return `快照也失败了：${error.message}`;
  }
}

async function main() {
  log(`[shot] 打开 ${URL_TARGET}`);
  const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false, backgroundColor: "#1b1b1a" });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log(`[shot] 加载失败 ${code} ${desc} ${url}`));
  // ⛔ 把渲染进程的控制台搬进日志：界面脚本一旦抛错，Electron 默认什么都不说，
  //   而 Windows 上 GUI 进程的 stderr 又不接管道 ⇒ 现场只剩"超时"两个字。
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    log(`[console:${level}] ${message}  (${String(source).split("/").pop()}:${line})`);
  });

  // ⛔ 预置 token（可选）：走查要能反复跑，而配对码是一次性的、5 分钟过期 ——
  //   把伴生服务的 token 直接塞进 localStorage，就绕开了"每次跑都要人工取码"。
  //   先空载一次只为拿到 localStorage 读写权限，再重新加载让应用带着 token 启动。
  if (process.env.SHOT_TOKEN) {
    await win.loadURL(URL_TARGET);
    await win.webContents.executeJavaScript(
      `localStorage.setItem("chc-token", ${JSON.stringify(process.env.SHOT_TOKEN)});` +
      `localStorage.setItem("chc-theme", ${JSON.stringify(process.env.SHOT_THEME || "dark")});`
    );
  }

  // SHOT_SIMPLE=1：只加载 + 等指定毫秒 + 拍一张就退（看"服务没起"这类静态现场用）
  if (process.env.SHOT_SIMPLE) {
    await win.loadURL(URL_TARGET);
    await sleep(Number(process.env.SHOT_SIMPLE) || 7000);
    report.probe.body = await win.webContents.executeJavaScript(`document.body.innerText.slice(0, 400)`);
    report.probe.gateVisible = await win.webContents.executeJavaScript(`!document.getElementById("gate").hidden`);
    await shot(win, `${LABEL}-state-${WIDTH}`);
    log(`[shot] 现场文本：\n${report.probe.body}`);
    fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-report.json`), JSON.stringify(report, null, 2));
    app.quit();
    return;
  }

  try {
    await win.loadURL(URL_TARGET);
    await waitForJs(win, "window.__chcReady === true", 15_000, "外壳与客户端就绪（__chcReady）");
  } catch (error) {
    log(`[shot] 就绪失败，现场快照：\n${await diagnose(win)}`);
    throw error;
  }
  await sleep(500);

  report.probe.status = await win.webContents.executeJavaScript(`document.querySelector("#chc-status")?.textContent || ""`);
  report.probe.note = await win.webContents.executeJavaScript(`document.querySelector("#chc-note")?.textContent || ""`);
  report.probe.fontFamily = await win.webContents.executeJavaScript(`getComputedStyle(document.body).fontFamily`);
  // 样式到底有没有生效：看每张表能不能读出规则数（读出 0/-1 = 没加载或被拒），
  // 再看 #boot 有没有被 display:none 藏掉、.app 有没有变成 grid。
  report.probe.sheets = await win.webContents.executeJavaScript(`JSON.stringify(
    [...document.styleSheets].map((sheet) => ({
      href: sheet.href,
      rules: (() => { try { return sheet.cssRules.length; } catch (e) { return "ERR:" + e.name; } })(),
    }))
  )`);
  report.probe.bootDisplay = await win.webContents.executeJavaScript(`getComputedStyle(document.getElementById("boot")).display`);
  report.probe.appDisplay = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector(".app")).display`);
  report.probe.appColumns = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector(".app")).gridTemplateColumns`);
  report.probe.buttonAppearance = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector(".btn")).appearance`);
  // 资产到底从哪儿来的：云端还是本地回落（两条路都得能跑）
  // 资产到底从哪儿来的：外壳选址的结果（云端 / 本地副本）
  report.probe.assetBase = await win.webContents.executeJavaScript(`window.__CHC_ASSET_BASE__ || "(未设置)"`);
  report.probe.agentBase = await win.webContents.executeJavaScript(`window.__CHC_AGENT__ || "(未设置)"`);
  await shot(win, `${LABEL}-01-ready-${WIDTH}`);

  // 发一条消息，走完"询问卡 → 审批卡 → 流式正文"
  // 界面状态快照：send() 失败时错误只写在 #chc-hint 里，不看它就只剩"卡没出现"四个字
  const snapUi = () => win.webContents.executeJavaScript(`JSON.stringify({
    hint: document.querySelector("#chc-hint")?.textContent || "",
    threads: document.querySelectorAll(".thread-item").length,
    streamChildren: document.querySelector("#chc-stream")?.children.length ?? -1,
    running: !document.querySelector("#chc-stop")?.hidden,
    title: document.querySelector("#chc-title")?.textContent || "",
    lastKinds: [...document.querySelectorAll("#chc-stream > *")].slice(-4).map((el) => el.className),
    apps: document.querySelectorAll(".app").length,
    streams: document.querySelectorAll("#chc-stream").length,
    userMsgs: document.querySelectorAll(".msg.user").length,
    agentMsgs: document.querySelectorAll(".msg.agent").length,
    events: (window.__chcEvents || []).slice(-14),
  })`);

  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector("#chc-input");
    input.value = "把设置页的个性化分组重排一下，顺便把暗色下看不清的控件修掉";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#chc-send").click();
    return true;
  })()`);
  await sleep(400);
  log(`[shot] 发送后界面快照：${await snapUi()}`);
  try {
    await waitForJs(win, "!!document.querySelector('#chc-stream .card')", 10_000, "询问卡出现");
  } catch (error) {
    log(`[shot] 询问卡没出现，界面快照：${await snapUi()}`);
    await shot(win, `${LABEL}-99-failure-${WIDTH}`);
    throw error;
  }
  await sleep(200);
  await shot(win, `${LABEL}-02-ask-${WIDTH}`);
  report.probe.askOptions = await win.webContents.executeJavaScript(`document.querySelectorAll('#chc-stream .card .option').length`);
  report.probe.askTitle = await win.webContents.executeJavaScript(`document.querySelector("#chc-stream .card .card-title")?.textContent || ""`);

  // 勾两项（多选）再提交
  await win.webContents.executeJavaScript(`(() => {
    const options = [...document.querySelectorAll('#chc-stream .card .option')];
    options[0]?.click(); options[1]?.click();
    return options.filter((o) => o.getAttribute("aria-pressed") === "true").length;
  })()`);
  report.probe.pressedAfterTwoClicks = await win.webContents.executeJavaScript(`document.querySelectorAll('#chc-stream .card .option[aria-pressed="true"]').length`);
  await shot(win, `${LABEL}-03-ask-selected-${WIDTH}`);
  await click(win, "#chc-stream .card .btn.primary");

  await waitForJs(win, `document.querySelectorAll('#chc-stream .card').length >= 2`, 10_000, "审批卡出现");
  await sleep(200);
  await shot(win, `${LABEL}-04-approval-${WIDTH}`);
  report.probe.approvalCode = await win.webContents.executeJavaScript(`document.querySelectorAll("#chc-stream .card .card-code")[0]?.textContent || ""`);

  await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll("#chc-stream .card")];
    const last = cards[cards.length - 1];
    const accept = [...last.querySelectorAll("button")].find((b) => b.textContent.includes("允许"));
    accept?.click();
    return true;
  })()`);
  await waitForJs(win, "!document.querySelector('#chc-stop') || document.querySelector('#chc-stop').hidden", 15_000, "回合结束");
  await sleep(400);
  await shot(win, `${LABEL}-05-done-${WIDTH}`);
  report.probe.agentText = await win.webContents.executeJavaScript(`[...document.querySelectorAll(".msg.agent .bubble")].map((b) => b.textContent).join(" | ")`);
  report.probe.resolvedCards = await win.webContents.executeJavaScript(`document.querySelectorAll("#chc-stream .card.resolved").length`);
  report.probe.threadCount = await win.webContents.executeJavaScript(`document.querySelectorAll(".thread-item").length`);

  // 暗色（应用启动时就是暗色，这里只验切换按钮有效）
  await click(win, "#chc-theme");
  await sleep(400);
  await shot(win, `${LABEL}-06-theme-${WIDTH}`);
  report.probe.theme = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme`);

  // 窄屏：侧栏收起 + 单列
  win.setSize(430, HEIGHT);
  await sleep(500);
  await shot(win, `${LABEL}-07-narrow-430`);
  report.probe.narrowOverflow = await win.webContents.executeJavaScript(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  report.probe.narrowRailHidden = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector(".rail")).display === "none"`);
  report.probe.narrowLayout = await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector(".app")).gridTemplateColumns + " | toggle=" + getComputedStyle(document.querySelector(".rail-toggle")).display`);

  log(`[shot] ==== 探针 ====\n${JSON.stringify(report.probe, null, 2)}`);
  fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-report.json`), JSON.stringify(report, null, 2));
  app.quit();
}

/**
 * ⛔⛔ 必须等 `app.whenReady()` 之后再建窗口：直接在模块顶层调 `main()` 会在 ready 之前
 *   执行到 `new BrowserWindow()`，抛 `Cannot create BrowserWindow before app is ready`，
 *   窗口永远建不出来、一张图都截不到（第一次跑走查就是栽在这里，而日志又落在文件里、
 *   Windows 下 Electron 还不接管道 ⇒ 现场看起来只是"exit=-1、零输出"，白查了半天）。
 */
app.whenReady()
  .then(main)
  .catch((error) => {
    log(`[shot] 失败：${error.stack || error.message}`);
    report.error = String(error.stack || error.message);
    try { fs.writeFileSync(path.join(OUT_DIR, `${LABEL}-report.json`), JSON.stringify(report, null, 2)); } catch { /* 忽略 */ }
    app.exit(1);
  });
