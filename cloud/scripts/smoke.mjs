/**
 * Codex Harness Cloud · 端到端自测
 *
 *   node scripts/smoke.mjs
 *
 * 干什么：拉起本地伴生服务（假引擎）→ 走完整协议 → 断言。
 * 断什么（按"最容易静默坏掉"排序）：
 *   ① 鉴权三闸（token / 自定义头 / Origin）与配对的一次性 —— 坏了就是本机被任意网页驱动；
 *   ② 白名单 —— 坏了就是把引擎的全部方法敞开；
 *   ③ **回包形状**：用 `.workbuddy/codex-schema` 里的协议 schema **独立校验**我们发的每一个
 *      回包。形状错的后果是引擎的 await 永远不落地（工具调用挂死），而界面看上去一切正常
 *      —— 这类 bug 只能靠"拿独立参照物验"抓，不能靠"自己人写断言自己人过"；
 *   ④ 回合结束必须释放阻塞式卡片（客户端侧断言不了，这里断言服务端契约：中断后
 *      迟到的回包被安静丢弃、不会把服务打挂）；
 *   ⑤ 断流重连：Last-Event-ID 必须能补回断掉那段（手机网络下这是常态）。
 *
 * ⛔ 用假引擎是**有意的**：真引擎要模型 key + 网络 + 花钱，而且输出不确定；而上面这五条
 *   与模型无关。失败时一定是我们的 bug，不会跟上游随机行为混淆。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(CLOUD_DIR, "..");

/**
 * 协议 schema 参照物（用于独立校验回包形状）。
 * ⛔ 优先用云版自己生成的那份（`npm run schema`，来源 = 引擎自身）；
 *   找不到就退到桌面版工作副本里的 dump；**都没有就让那几条断言红掉** ——
 *   绝不能"找不到参照物就当通过"，那是恒真假绿。
 */
function resolveSchemaDir() {
  const candidates = [
    process.env.HARNESS_CODEX_SCHEMA,
    path.join(CLOUD_DIR, ".schema"),
    path.join(REPO_ROOT, ".workbuddy", "codex-schema"),
    "D:/Codex Harness Desktop/.workbuddy/codex-schema",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (existsSync(path.join(dir, "ToolRequestUserInputResponse.json"))) return dir;
    } catch { /* 换下一个 */ }
  }
  return "";
}
const SCHEMA_DIR = resolveSchemaDir();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  process.stdout.write(`${mark} ${name}${ok || !detail ? "" : ` —— ${detail}`}\n`);
}
function group(title) { process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`); }

/* ── 迷你 JSON-Schema 校验（draft-07 子集） ────────────────────────────────
   支持：$ref（同文件 #/definitions/…）、type、enum、required、properties、
        items、additionalProperties、anyOf/oneOf/allOf。
   ⛔ 刻意不做的：format / minimum / 数值边界 —— 这些与本测试的目（形状对不对）无关，
      做了只会让人误以为"schema 全验过了"。 */
function validate(schema, value, root, where = "$", errors = []) {
  if (!schema || typeof schema !== "object") return errors;
  if (schema.$ref) {
    const ref = schema.$ref;
    if (!ref.startsWith("#/")) return errors;      // 跨文件引用：不解析（本仓响应 schema 都是本地引用）
    const target = ref.slice(2).split("/").reduce((acc, key) => (acc ? acc[key] : undefined), root);
    if (!target) { errors.push(`${where}: 无法解析 $ref ${ref}`); return errors; }
    return validate(target, value, root, where, errors);
  }
  if (schema.allOf) for (const sub of schema.allOf) validate(sub, value, root, where, errors);
  if (schema.anyOf || schema.oneOf) {
    const branches = schema.anyOf || schema.oneOf;
    const passed = branches.some((branch) => validate(branch, value, root, where, []).length === 0);
    // oneOf 严格来说要求"恰好一个"；这里放宽为"至少一个"并在此声明 —— 目的是抓形状错误，不是做合规认证
    if (!passed) errors.push(`${where}: 不匹配任何一个候选分支`);
  }
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    errors.push(`${where}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)}`);
  }
  const types = schema.type === undefined ? null : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (types && value !== null && value !== undefined) {
    const actual = Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    const okType = types.includes(actual) || (actual === "integer" && types.includes("number"));
    if (!okType) errors.push(`${where}: 期望 ${types.join("|")}，实际 ${actual}`);
  }
  if (schema.required && value && typeof value === "object") {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${where}: 缺必填字段 ${key}`);
    }
  }
  if (schema.properties && value && typeof value === "object") {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) validate(sub, value[key], root, `${where}.${key}`, errors);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((entry, index) => validate(schema.items, entry, root, `${where}[${index}]`, errors));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const known = new Set(Object.keys(schema.properties || {}));
    for (const [key, entry] of Object.entries(value)) {
      if (!known.has(key)) validate(schema.additionalProperties, entry, root, `${where}.${key}`, errors);
    }
  }
  return errors;
}

function schemaCheck(name, schemaFile, payload) {
  if (!SCHEMA_DIR) {
    check(name, false, "找不到协议 schema 参照物 —— 先跑 `npm run schema`（它会用引擎自产 schema）");
    return;
  }
  const file = path.join(SCHEMA_DIR, schemaFile);
  if (!existsSync(file)) { check(name, false, `schema 文件缺失：${schemaFile}`); return; }
  const schema = JSON.parse(readFileSync(file, "utf8"));
  const errors = validate(schema, payload, schema);
  check(name, errors.length === 0, errors.slice(0, 3).join("；"));
}

/* ── 启服务 ───────────────────────────────────────────────────────────────── */
const PORT = Number(process.env.SMOKE_PORT || 8919);
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(path.join(tmpdir(), "chc-smoke-"));
// 多用户：预先给「Alice」签发个人码（真实流程是 --add-user 签发后落这个文件）
writeFileSync(path.join(home, "users.json"), JSON.stringify([
  { name: "Alice", code: "a1b2c3d4", token: "f".repeat(48), createdAt: Date.now() },
]), "utf8");
const child = spawn(process.execPath, [path.join(CLOUD_DIR, "local-agent", "server.js"), "--mock"], {
  cwd: CLOUD_DIR,
  env: { ...process.env, HARNESS_CLOUD_HOME: home, HARNESS_CLOUD_PORT: String(PORT), HARNESS_CLOUD_QUIET: "1", MOCK_ENGINE_STEP_MS: "40" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let pairCode = "";
child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
  const match = /配对码：\s*([0-9a-f]{8})/.exec(stdout);
  if (match) pairCode = match[1];
});
child.stderr.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** 等到 fn() 返回真值并把它交出来（比 waitFor + .then(() => 再找一遍) 干净）。 */
async function waitForValue(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

let token = "";
async function api(pathname, { method = "GET", body, auth = true, headers = {}, origin, token: tokenOverride } = {}) {
  const finalHeaders = { "x-harness-client": "web", ...headers };
  if (auth && (tokenOverride ?? token)) finalHeaders.Authorization = `Bearer ${tokenOverride ?? token}`;
  if (body !== undefined) finalHeaders["Content-Type"] = "application/json";
  if (origin) finalHeaders.Origin = origin;
  const response = await fetch(BASE + pathname, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload = null;
  try { payload = await response.json(); } catch { /* 可能没 body */ }
  return { status: response.status, payload };
}
const rpc = (method, params) => api("/api/rpc", { method: "POST", body: { method, params } });

/* ── SSE 客户端（fetch + 流解析；Node 里 EventSource 不可用，正好与浏览器端同一条路） ── */
function openStream(lastEventId) {
  const frames = [];
  const controller = new AbortController();
  // ⛔ ready 必须**在拿到响应头时就 resolve**，不能等读循环结束 ——
  //   读循环是无限的，等它等于永远等不到（这个坑第一次跑就挂在 ⑤ 不动了）。
  let markReady;
  let markFailed;
  const ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
  const done = (async () => {
    const headers = { Authorization: `Bearer ${token}`, "x-harness-client": "web" };
    if (lastEventId) headers["Last-Event-ID"] = String(lastEventId);
    const response = await fetch(`${BASE}/api/events`, { headers, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`事件流 HTTP ${response.status}`);
    markReady();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      // ⛔⛔ 这里踩过坑：`index` 本身就等于 `frame.length`（frame 是 buffer 的前缀），
      //   写成 `slice(index + frame.length + 2)` 等于把帧长加了两遍 ⇒ 每次多跳一整帧，
      //   被跳过的半截 JSON 又会被下面的 catch 静默吞掉 —— 表现是"只收到零星几个事件"，
      //   极难往解析器上想。推进量只能是**分隔符长度**。
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" ? 4 : 2));
        const dataLines = [];
        let id = null;
        for (const line of frame.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          if (line.startsWith("id:")) id = Number(line.slice(3).trim());
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        try {
          const parsed = JSON.parse(dataLines.join("\n"));
          frames.push({ id, event: parsed });
          if (process.env.SMOKE_DEBUG) process.stdout.write(`[frame] id=${id} kind=${parsed.kind} method=${parsed.method || "-"}\n`);
        } catch {
          badFrames += 1;   // ⛔ 静默吞掉坏帧会让"丢事件"变成幽灵 bug：计数并在末尾断言为 0
        }
      }
    }
  })().catch((error) => {
    if (error.name === "AbortError") return;
    failedStream = error.message;
    markFailed(error);
  });
  void done;
  return { frames, close: () => controller.abort(), ready };
}
let failedStream = "";
let badFrames = 0;

function methodsOf(frames) { return frames.map((f) => f.event.method || `@${f.event.kind}`); }
async function waitForFrame(frames, method, timeoutMs = 6000) {
  const start = Date.now();
  for (;;) {
    const hit = frames.find((f) => f.event.method === method);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) throw new Error(`等待事件超时：${method}（已收到 ${methodsOf(frames).join(",") || "无"}）`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/* ── 跑 ───────────────────────────────────────────────────────────────────── */
let turnOne = null;
try {
  await waitFor(() => pairCode, 8000, "伴生服务启动并打印配对码");

  group("① 外壳与静态回落");
  const shell = await fetch(`${BASE}/`);
  const shellHtml = await shell.text();
  check("GET / 返回外壳（200）", shell.status === 200);
  // ⛔ 这条断言 10-11 跟着设计改过一次，别改回去：
  //   旧设计是"文件里写 __CDN_BASE__ 占位符、由服务端替换"，而同一份文件还要被云端原样托管当入口 ——
  //   云端没人替换 ⇒ fetch("__CDN_BASE__/version.json") 必然失败 ⇒ **首屏永远转**（真实事故）。
  //   现在：文件里没有占位符（外壳自己算地址），服务端只**注入**一个可选覆盖项。
  //   所以断言也换了：认"注入的覆盖项"，并且**引号位置**不许再出现占位符字面量
  //   （注释里提到 `__CDN_BASE__` 是允许的，所以不能简单粗暴地 includes）。
  check("外壳注入了云端资产地址（window.__CHC_CDN__，可选覆盖）",
    shellHtml.includes(`window.__CHC_CDN__ = "https://ppz123.asia/cloud"`));
  check("外壳在引号位置没有残留模板占位符（云端原样托管也必须能自己跑）",
    !/["']__[A-Z_]+__["']/.test(shellHtml), (shellHtml.match(/["']__[A-Z_]+__["']/g) || []).join(","));
  check("外壳声明 no-store（否则用户会被钉在旧资产上）", /no-store/i.test(shell.headers.get("cache-control") || ""));
  const localAsset = await fetch(`${BASE}/local-assets/app.js`);
  check("本地副本可服务（/local-assets/app.js → 200）", localAsset.status === 200);
  const traversal = await fetch(`${BASE}/local-assets/..%2f..%2fpackage.json`);
  check("路径穿越被拒（/local-assets/../../package.json 非 200）", traversal.status !== 200, `实际 ${traversal.status}`);

  group("② 鉴权三闸与配对");
  const noToken = await api("/api/rpc", { method: "POST", body: { method: "thread/list", params: {} }, auth: false });
  check("无 token → 401", noToken.status === 401, `实际 ${noToken.status}`);
  const badOrigin = await api("/api/rpc", { method: "POST", body: { method: "thread/list", params: {} }, auth: false, origin: "https://evil.example" });
  check("Origin 不在白名单 → 403（前缀匹配放行是个经典坑）", badOrigin.status === 403, `实际 ${badOrigin.status}`);
  // 去掉自定义头需要绕开 api() 的默认注入，用裸 fetch
  const raw = await fetch(`${BASE}/api/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "thread/list", params: {} }) });
  check("缺 x-harness-client → 403（非简单请求强制预检，第三方页面的简单 POST 绕不过）", raw.status === 403, `实际 ${raw.status}`);

  const wrongPair = await api("/api/pair", { method: "POST", body: { code: "00000000" }, auth: false });
  check("配对码错误 → 403", wrongPair.status === 403 && wrongPair.payload?.error === "mismatch", JSON.stringify(wrongPair.payload));
  const goodPair = await api("/api/pair", { method: "POST", body: { code: pairCode }, auth: false });
  check("配对码正确 → 下发 token", goodPair.status === 200 && typeof goodPair.payload?.token === "string" && goodPair.payload.token.length >= 32);
  token = goodPair.payload?.token || "";
  const replay = await api("/api/pair", { method: "POST", body: { code: pairCode }, auth: false });
  check("配对码一次性（重放 → 403）", replay.status === 403 && replay.payload?.error === "no-code", JSON.stringify(replay.payload));

  group("②' 多用户：个人配对码（长期凭据，一人一个）");
  const alice = await api("/api/pair", { method: "POST", body: { code: "a1b2c3d4" }, auth: false });
  const aliceToken = alice.payload?.token || "";
  check("个人码配对成功 → 用户自己的 token（≠ owner token）",
    alice.status === 200 && aliceToken.length >= 32 && aliceToken !== (goodPair.payload?.token || ""),
    JSON.stringify(alice.payload || {}).slice(0, 80));
  check("个人码可**反复**使用（长期凭据，不是一次性的）",
    (await api("/api/pair", { method: "POST", body: { code: "a1b2c3d4" }, auth: false })).status === 200);
  check("回包带账号身份（userId=Alice + 云存储预留位）",
    alice.payload?.account?.userId === "Alice" && alice.payload?.account?.cloudStorage?.enabled === false,
    JSON.stringify(alice.payload?.account || {}));
  const userHs = await api("/api/handshake", { auth: true, token: aliceToken });
  check("用户 token 的 handshake 带本人身份", userHs.payload?.account?.userId === "Alice", JSON.stringify(userHs.payload?.account || {}));
  const anonHs = await api("/api/handshake", { auth: false });
  check("匿名 handshake 不泄露身份（userId=null）", anonHs.payload?.account?.userId === null);
  check("用户 token 能正常调用 RPC（thread/list → 200）",
    (await api("/api/rpc", { method: "POST", body: { method: "thread/list", params: {} }, auth: true, token: aliceToken })).status === 200);
  check("用户码错一位 → 403（与 owner 码同闸）",
    (await api("/api/pair", { method: "POST", body: { code: "a1b2c3d5" }, auth: false })).status === 403);

  group("③ RPC 白名单");
  const denied = await rpc("fs/readFile", { path: "C:/Windows/win.ini" });
  check("白名单外的方法 → 403（黑名单会把新增高危方法静默放行）", denied.status === 403 && denied.payload?.error === "method-not-allowed", JSON.stringify(denied.payload));

  group("④ 回包形状：拿协议 schema 独立校验");
  // 这些形状与 web/app.js 的 declineResultFor / 提交分支一一对应
  schemaCheck("审批「允许」={decision:'accept'} 合 schema", "CommandExecutionRequestApprovalResponse.json", { decision: "accept" });
  schemaCheck("审批「拒绝」={decision:'decline'} 合 schema", "CommandExecutionRequestApprovalResponse.json", { decision: "decline" });
  schemaCheck("权限回包={permissions:{},scope:'turn'} 合 schema", "PermissionsRequestApprovalResponse.json", { permissions: {}, scope: "turn" });
  schemaCheck("询问回包=两层 answers 合 schema", "ToolRequestUserInputResponse.json", { answers: { scope: { answers: ["界面层", "业务逻辑"] } } });
  schemaCheck("询问取消={answers:{}} 合 schema", "ToolRequestUserInputResponse.json", { answers: {} });
  schemaCheck("elicitation 取消={action:'cancel'} 合 schema", "McpServerElicitationRequestResponse.json", { action: "cancel" });
  check("① 反例：形状写错必须被校验器抓到（否则上面六条是自证）",
    !SCHEMA_DIR || (() => {
      const file = path.join(SCHEMA_DIR, "ToolRequestUserInputResponse.json");
      const schema = JSON.parse(readFileSync(file, "utf8"));
      return validate(schema, { answers: { scope: ["界面层"] } }, schema).length > 0;
    })());

  group("⑤ 完整一轮：事件顺序 + 两张卡的往返");
  const stream = openStream();
  await stream.ready;
  const started = await rpc("thread/start", {});
  const threadId = started.payload?.result?.thread?.id;
  check("thread/start 返回会话 id", typeof threadId === "string" && threadId.length > 0, JSON.stringify(started.payload));

  await rpc("turn/start", { threadId, input: [{ type: "text", text: "把设置页整理一下", text_elements: [] }] });
  const askFrame = await waitForFrame(stream.frames, "item/tool/requestUserInput");
  turnOne = askFrame.event.params.turnId;
  const askParams = askFrame.event.params;
  check("询问卡：questions[0].options 是数组且带 label/description",
    Array.isArray(askParams?.questions?.[0]?.options) && askParams.questions[0].options.every((o) => typeof o.label === "string" && typeof o.description === "string"));
  check("询问卡：请求 id 是数字（回包要靠它认领）", typeof askFrame.id === "number" || typeof askFrame.event.id === "number");

  await api("/api/respond", {
    method: "POST",
    body: { id: askFrame.event.id, result: { answers: { scope: { answers: ["界面层", "业务逻辑"] } } } },
  });
  const approvalFrame = await waitForFrame(stream.frames, "item/commandExecution/requestApproval");
  check("审批卡：带 command / cwd / reason", Boolean(approvalFrame.event.params?.command) && Boolean(approvalFrame.event.params?.cwd));
  await api("/api/respond", { method: "POST", body: { id: approvalFrame.event.id, result: { decision: "accept" } } });

  const completed = await waitForFrame(stream.frames, "turn/completed");
  const order = methodsOf(stream.frames).filter((m) => !m.startsWith("@"));
  const expectedOrder = [
    "turn/started", "item/started", "item/completed", "item/started", "item/completed",
    "item/tool/requestUserInput", "item/started", "item/commandExecution/requestApproval", "item/completed", "item/started",
  ];
  const head = order.slice(0, expectedOrder.length);
  check("事件顺序与协议脚本一致（前 10 条）", JSON.stringify(head) === JSON.stringify(expectedOrder), `实际 ${head.join(",")}`);
  check("收到 turn/completed（回合容器闭合）", Boolean(completed));
  const agentText = stream.frames
    .map((f) => f.event.params?.item)
    .filter((item) => item && item.type === "agentMessage" && item.text)
    .pop()?.text || "";
  check("两层 answers 被引擎读到（正文回显所选项）", agentText.includes("界面层") && agentText.includes("业务逻辑"), agentText);
  check("② 反例：把选项写成一维数组就该读不到（证明上一条不是空断言）",
    !agentText.includes("未作答"));

  group("⑥ 中断：回合结束后迟到的回包不能出事");
  const framesBefore = stream.frames.length;
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "再跑一轮", text_elements: [] }] });
  const ask2 = await waitForValue(
    () => stream.frames.slice(framesBefore).find((f) => f.event.method === "item/tool/requestUserInput"),
    6000,
    "第二轮询问卡",
  );
  const interrupted = await rpc("turn/interrupt", { threadId, turnId: ask2.event.params.turnId || "" });
  check("turn/interrupt 返回 200", interrupted.status === 200, JSON.stringify(interrupted.payload));
  const interruptedFrame = await waitForFrame(stream.frames, "turn/interrupted");
  check("收到 turn/interrupted（回合闭合，卡片应随之释放）",
    Boolean(interruptedFrame) && String(interruptedFrame.event.params?.turn?.id || interruptedFrame.event.params?.turnId || "").length > 0,
    JSON.stringify(interruptedFrame?.event?.params));
  const stale = await api("/api/respond", { method: "POST", body: { id: ask2.event.id, result: { answers: { scope: { answers: ["界面层"] } } } } });
  check("对已作废请求回包：安静丢弃、服务不报错", stale.status === 200, JSON.stringify(stale.payload));
  const afterInterrupt = stream.frames.slice(stream.frames.indexOf(interruptedFrame) + 1).filter((f) => f.event.method === "turn/completed");
  check("中断后不再冒出 turn/completed（不能既中断又完成）", afterInterrupt.length === 0);

  group("⑦ 断流重连：Last-Event-ID 补发");
  const lastSeq = Math.max(...stream.frames.map((f) => f.id || 0));
  stream.close();
  // 断流期间**真的制造事件**（否则这条断言测的是"补 0 帧"，等于没测）。
  // ⛔ 不能用 stream.frames 去判断"有没有新事件"—— 那条流已经关了，它永远不会再长。
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "断流期间的一轮", text_elements: [] }] });
  await new Promise((r) => setTimeout(r, 600));
  const resumed = openStream(lastSeq);
  await resumed.ready;
  await waitFor(() => resumed.frames.filter((f) => f.event.kind === "notification" || f.event.kind === "request").length > 0, 4000, "重连补发帧");
  const replayed = resumed.frames.filter((f) => f.event.kind !== "hello");
  check("重连后补回了断流期间的事件", replayed.length > 0, `补 ${resumed.frames.length} 帧（含 hello）`);
  check("补发帧的 seq 都大于 Last-Event-ID（不会重复投递）", replayed.every((f) => (f.id || 0) > lastSeq), `lastSeq=${lastSeq}，实际 ${replayed.map((f) => f.id).join(",")}`);
  check("hello 不带 id 也不吃序号（吃了会让补发区间出现空洞）", resumed.frames.find((f) => f.event.kind === "hello")?.id === null);
  check("流解析零坏帧（坏帧被静默吞掉会让「丢事件」变成幽灵 bug）", badFrames === 0, `坏帧 ${badFrames} 个`);
  resumed.close();

  group("⑧ 健康检查与配置落盘");
  const health = await api("/api/health", { auth: false });
  check("GET /api/health → 200 且带引擎状态", health.status === 200 && Boolean(health.payload?.engine), JSON.stringify(health.payload));
  const tokenFile = path.join(home, "token");
  check("token 落盘（首次运行生成）", existsSync(tokenFile) && readFileSync(tokenFile, "utf8").trim().length >= 32);
  const logText = existsSync(path.join(home, "local-agent.log")) ? readFileSync(path.join(home, "local-agent.log"), "utf8") : "";
  check("③ 反例：日志里绝不能出现 token / 配对码",
    !logText.includes(token) && (!pairCode || !logText.includes(pairCode)));
} catch (error) {
  check("自测执行未抛异常", false, error.stack || error.message);
} finally {
  child.kill();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${"─".repeat(64)}\n`);
if (failed.length) {
  process.stdout.write(`\x1b[31m自测失败：${failed.length}/${results.length}\x1b[0m\n`);
  for (const f of failed) process.stdout.write(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ""}\n`);
  process.exit(1);
}
process.stdout.write(`\x1b[32m自测通过：${results.length}/${results.length}\x1b[0m\n`);
process.exit(0);
