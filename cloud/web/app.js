/* ══════════════════════════════════════════════════════════════════════════
   Codex Harness Cloud · Web 客户端
   ⛔ 单文件、零 import —— 这是**故意的**：本文件默认从云端加载，云端不可达时靠
      外壳插入的第二条 <script> 指向本地副本。有 import 的话那条回落链会因为
      模块解析基准不同而散开，离线场景必挂。加依赖前先想清楚这一点。
   ⛔ 所有来自模型/引擎的文本一律走 textContent，**绝不拼 innerHTML** ——
      模型输出（含被读取的文件内容）是不可信输入，拼 HTML 等于把 XSS 送到自己界面上。
   ⛔ 协议边界只认"引擎真形状"：回合类通知是 `{ threadId, turn: { id, status } }`，
      询问回包是**两层 answers**（`{ answers: { <qid>: { answers: [...] } } }`）。
      容错读法（`params.turn?.id ?? params.turnId`）可以有，但必须紧挨着真形状写。
   ══════════════════════════════════════════════════════════════════════════ */

const SHELL = window.__CHC_SHELL__ || {};
const PROTOCOL_VERSION = SHELL.protocolVersion ?? 0;
const CLIENT_NAME = "web";

const LS = { token: "chc-token", theme: "chc-theme", thread: "chc-thread" };

const state = {
  token: "",
  raw: "",              // 待输入的配对码
  ready: false,
  server: { protocolVersion: 0, agentVersion: "", mock: false, engine: {}, capabilities: {} },
  threads: [],
  activeThreadId: "",
  turnId: "",           // 当前回合 id（停止时要回传）
  running: false,
  pairing: false,
  error: "",
  // itemId → { el, type, text }
  items: new Map(),
  // requestId → { method, el, settle }
  pending: new Map(),
  streamAbort: null,
  streamSeq: 0,
};

/* ── 工具 ─────────────────────────────────────────────────────────────────── */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function shortId(id) {
  const text = String(id || "");
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function timeLabel(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ── API 层 ───────────────────────────────────────────────────────────────── */
/**
 * ⛔ 两个头都不能省：
 *   Authorization  —— 凭据**不放 Cookie**，第三方页面无法自动携带。
 *   x-harness-client —— 让请求变成"非简单请求"，浏览器强制先发 CORS 预检，
 *     预检不通过真实请求根本发不出去。这是挡住"任意网页打本机回环"的关键。
 */
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "x-harness-client": CLIENT_NAME };
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    throw new Error(`本地伴生服务不可达（${error.message}）`);
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* 空响应体 */ }
  if (!response.ok) {
    const error = new Error((payload && payload.error) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const rpc = (method, params) => api("/api/rpc", { method: "POST", body: { method, params } });

/* ── 事件流 ───────────────────────────────────────────────────────────────── */
/**
 * ⛔ 为什么不用 EventSource：它**不能设置请求头**，token 只能塞进 URL（会进历史记录、
 *   进代理日志）。这里用 fetch + ReadableStream 自己解析 SSE，于是能带 Authorization，
 *   也能自己控制重连与 Last-Event-ID（断流补发那段在服务端的环形缓冲里）。
 */
async function streamEvents() {
  if (state.streamAbort) state.streamAbort.abort();
  const controller = new AbortController();
  state.streamAbort = controller;
  let backoff = 800;
  while (!controller.signal.aborted) {
    try {
      const response = await fetch("/api/events", {
        headers: {
          Authorization: `Bearer ${state.token}`,
          "x-harness-client": CLIENT_NAME,
          ...(state.streamSeq ? { "Last-Event-ID": String(state.streamSeq) } : {}),
        },
        signal: controller.signal,
      });
      if (response.status === 401) { state.token = ""; localStorage.removeItem(LS.token); state.pairing = true; render(); return; }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      setConnection(true);
      backoff = 800;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔；\r\n 也要认（有的中间层会改写换行）
        // ⛔⛔ 推进量只能是**分隔符长度**。这里踩过一个大坑：写成
        //   `slice(index + frame.length + sep)` 等于把帧长加两遍（frame 就是 buffer
        //   的前缀，index === frame.length）⇒ 每次多跳一整帧，被跳过的半截 JSON 又
        //   会被 handleSseFrame 的 try 静默吞掉。症状极具迷惑性：**前几条事件正常、
        //   之后随机丢事件**（实测表现为"询问卡一直不出现"）。自测脚本里同一个 bug 也犯过。
        let index;
        while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + (buffer[index] === "\r" ? 4 : 2));
          handleSseFrame(frame);
        }
      }
      throw new Error("事件流已结束");
    } catch (error) {
      if (controller.signal.aborted) return;
      setConnection(false, error.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}

function handleSseFrame(frame) {
  let id = null;
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;          // 注释行 = 心跳
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (id !== null && Number.isFinite(id)) state.streamSeq = id;
  if (!dataLines.length) return;
  let event;
  try {
    event = JSON.parse(dataLines.join("\n"));
  } catch {
    // ⛔ 坏帧**必须报出来**：静默 return 会让"丢事件"变成幽灵 bug（上面那个推进量
    //   写错时，被吞掉的正是半截 JSON，一路查不到原因）。计数 + 打到控制台。
    state.badFrames = (state.badFrames || 0) + 1;
    if (state.badFrames <= 5) console.error("[chc] 坏帧（已丢弃）", dataLines.join("\n").slice(0, 200));
    return;
  }
  // ⛔ 单个事件处理失败**绝不能**把整条事件流带崩：reduce() 是同步调用，
  //   它一抛异常就会让读循环的 promise 落进 catch ⇒ 流静默停止，
  //   症状是"前几条事件正常、之后就再也不更新了"，而且没有任何错误信息。
  //   走查实测撞到过（询问卡一直不出现）。这里就地兜住并报出真因。
  try {
    reduce(event);
  } catch (error) {
    console.error("[chc] 事件处理失败", event && (event.method || event.kind), error);
  }
}

function setConnection(ok, detail) {
  state.connected = ok;
  state.connectionDetail = detail || "";
  renderPills();
}

/* ── 事件归约 ─────────────────────────────────────────────────────────────── */
/** 回合类通知一律 `{ threadId, turn: { id, status } }`；容错读法是历史产物，保留但不再新增。 */
function turnIdOf(params) {
  return String((params && params.turn && params.turn.id) || (params && params.turnId) || "");
}

function reduce(event) {
  // 事件留痕（最近 60 条）：排查"某条事件到底有没有到客户端"时，这是唯一的证据。
  // 走查台（scripts/shot.cjs）会把它读出来 —— 不然现场只剩"界面没反应"。
  try {
    window.__chcEvents = window.__chcEvents || [];
    window.__chcEvents.push(`${event.kind}:${event.method || "-"}`);
    if (window.__chcEvents.length > 60) window.__chcEvents.shift();
  } catch { /* 忽略 */ }

  if (event.kind === "hello") {
    state.connected = true;
    return;
  }
  if (event.kind === "status") {
    state.server.engine = { status: event.status, message: event.message };
    renderPills();
    return;
  }
  if (event.kind === "request") {
    if (event.params && event.params.threadId && state.activeThreadId && event.params.threadId !== state.activeThreadId) return;
    renderRequestCard(event.id, event.method, event.params || {});
    return;
  }
  if (event.kind !== "notification") return;

  const params = event.params || {};
  const threadId = String(params.threadId || "");
  // 非本会话的事件不渲染（但回合结束仍要认——它可能属于别的会话，须清掉它的卡）
  const isActive = !threadId || !state.activeThreadId || threadId === state.activeThreadId;

  switch (event.method) {
    case "turn/started": {
      const turnId = turnIdOf(params);
      if (isActive) {
        state.running = true;
        state.turnId = turnId;
        renderComposer();
      }
      return;
    }
    case "item/started":
    case "item/completed": {
      if (!isActive) return;
      const item = params.item || {};
      if (event.method === "item/started") startItem(item);
      else completeItem(item);
      scheduleStick();
      return;
    }
    case "item/agentMessage/delta": {
      if (!isActive) return;
      appendDelta(String(params.itemId || ""), String(params.delta ?? ""));
      scheduleStick();
      return;
    }
    case "turn/completed":
    case "turn/aborted":
    case "turn/failed":
    case "turn/interrupted": {
      // ⛔ 回合一结束，「等用户操作」的阻塞式卡片必须跟着消失 —— 它们代表的那个"答复"
      //   已经没有接收方了（引擎侧这个回合不存在了）。桌面版 10-11 修的正是这条；
      //   网页端没有理由再犯一次。
      releasePending(threadId, event.method);
      if (isActive) {
        state.running = false;
        state.turnId = "";
        state.error = event.method === "turn/failed" ? String(params.error?.message || "回合失败") : "";
        renderComposer();
      }
      return;
    }
    default:
      return;   // 其余通知（tokenUsage / diff / plan …）本客户端暂不呈现
  }
}

/* ── item 渲染 ────────────────────────────────────────────────────────────── */
function startItem(item) {
  const id = String(item.id || "");
  if (!id || state.items.has(id)) return;
  const type = String(item.type || "");
  if (type === "userMessage") {
    const node = h("div", { class: "msg user" },
      h("div", { class: "who", text: "你" }),
      h("div", { class: "bubble", text: textOfUserInput(item.content) }),
    );
    state.items.set(id, { el: node, type });
    streamAppend(node);
    return;
  }
  if (type === "agentMessage") {
    const body = h("div", { class: "bubble" });
    const node = h("div", { class: "msg agent" }, h("div", { class: "who", text: "Codex" }), body);
    state.items.set(id, { el: node, type, text: String(item.text || ""), body });
    streamAppend(node);
    return;
  }
  if (type === "reasoning") {
    const node = h("div", { class: "reasoning", text: "" });
    state.items.set(id, { el: node, type, text: "" });
    streamAppend(node);
    return;
  }
  // 工具类 item：卡片
  const { head, body, mode } = describeToolItem(item);
  const node = h("div", { class: "item" },
    h("div", { class: "item-head" }, h("span", { text: head })),
    body ? h("pre", { class: "item-body", text: body }) : null,
  );
  state.items.set(id, { el: node, type, mode, bodyEl: body ? node.querySelector(".item-body") : null });
  streamAppend(node);
}

function completeItem(item) {
  const id = String(item.id || "");
  const type = String(item.type || "");
  // 有些端点只发 item/completed（没有 started）——那时按 completed 建节点
  if (!state.items.has(id)) startItem(item);
  const entry = state.items.get(id);
  if (!entry) return;
  if (type === "agentMessage" && entry.body) {
    const text = String(item.text || "");
    if (text && entry.body.textContent !== text) entry.body.textContent = text;
    return;
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
    const content = Array.isArray(item.content) ? item.content.join("\n") : "";
    entry.el.textContent = [summary, content].filter(Boolean).join("\n") || entry.el.textContent;
    return;
  }
  if (entry.bodyEl) {
    const { body } = describeToolItem(item);
    if (body) entry.bodyEl.textContent = body;
  }
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0) || item.success === false;
  entry.el.classList.toggle("fail", Boolean(failed));
  entry.el.classList.add("done");
  const head = entry.el.querySelector(".item-head span");
  if (head) head.textContent = describeToolItem(item).head;
}

function appendDelta(itemId, delta) {
  if (!itemId || !delta) return;
  let entry = state.items.get(itemId);
  if (!entry) {
    // 只收到 delta（started 丢了 / 断流补发不全）：就地为它开一条 agent 消息，不要吞掉内容
    startItem({ id: itemId, type: "agentMessage", text: "" });
    entry = state.items.get(itemId);
    if (!entry) return;
  }
  entry.text = (entry.text || "") + delta;
  if (entry.body) entry.body.textContent = entry.text;
  else entry.el.textContent = entry.text;
}

function textOfUserInput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part) return "";
      if (part.type === "text") return String(part.text || "");
      if (part.type === "localImage") return `[图片] ${part.path || ""}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 工具类 item → 一行标题 + 正文。字段名照协议（见 codex_app_server_protocol.v2.schemas.json 的 ThreadItem）。 */
function describeToolItem(item) {
  const type = String(item.type || "");
  const status = item.status ? ` · ${item.status}` : "";
  switch (type) {
    case "commandExecution":
      return { head: `执行命令${status}`, body: [item.command, item.aggregatedOutput].filter(Boolean).join("\n\n") };
    case "fileChange": {
      const paths = Array.isArray(item.changes) ? item.changes.map((c) => (c && (c.path || c.filename)) || "?").join("\n") : "";
      return { head: `文件改动${status}`, body: paths };
    }
    case "mcpToolCall":
      return { head: `MCP 工具 ${item.server ? `${item.server}.` : ""}${item.tool || ""}${status}`, body: safeJson(item.arguments) };
    case "dynamicToolCall":
      return { head: `工具 ${item.tool || ""}${status}`, body: safeJson(item.arguments) };
    case "webSearch":
      return { head: `联网搜索${status}`, body: String(item.query || "") };
    case "imageView":
      return { head: "查看图片", body: String(item.path || "") };
    case "imageGeneration":
      return { head: "生成图片", body: [item.revisedPrompt, item.savedPath].filter(Boolean).join("\n") };
    case "plan":
      return { head: "计划", body: String(item.text || "") };
    case "functionCallOutput":
      return { head: `工具输出 ${item.name || ""}`, body: typeof item.output === "string" ? item.output : safeJson(item.output) };
    case "contextCompaction":
      return { head: "上下文压缩", body: "" };
    case "hookPrompt":
      return { head: "钩子提示", body: Array.isArray(item.fragments) ? item.fragments.length + " 段" : "" };
    default:
      return { head: type || "item", body: safeJson(item) };
  }
}

function safeJson(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/* ── 待答卡（审批 / 询问） ────────────────────────────────────────────────── */
const REQUEST_LABEL = {
  "item/commandExecution/requestApproval": "命令执行需要你确认",
  "item/fileChange/requestApproval": "文件改动需要你确认",
  "item/permissions/requestApproval": "请求追加权限",
  "item/tool/requestUserInput": "需要你回答",
  "mcpServer/elicitation/request": "外部服务请求确认",
};

/**
 * ⛔ 「取消 / 拒绝」的回包形状全部照协议 schema 抄 —— 编一份形状会让引擎的 await 永远
 *   不落地（工具调用挂死），或直接按非法参数丢掉。与桌面版 turn-overlays.ts 同源。
 *   · 审批类 → { decision: "decline" }
 *   · permissions → { permissions: {}, scope: "turn" }
 *   · requestUserInput → { answers: {} }（两层结构中"没作答"就是空对象）
 *   · elicitation → { action: "cancel" }（schema 明列三选一）
 */
function declineResultFor(method) {
  if (method.includes("requestApproval")) return { decision: "decline" };
  if (method.includes("permissions")) return { permissions: {}, scope: "turn" };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method.includes("elicitation")) return { action: "cancel" };
  return {};
}

function renderRequestCard(id, method, params) {
  const card = h("div", { class: "card", dataset: { requestId: String(id) } });
  const title = h("div", { class: "card-title" }, h("span", { text: REQUEST_LABEL[method] || method }));
  card.append(title);

  const settle = (result, note) => {
    if (!state.pending.has(id)) return;
    state.pending.delete(id);
    card.classList.add("resolved");
    for (const control of card.querySelectorAll("button, input")) control.disabled = true;
    if (note) {
      const existing = card.querySelector(".card-note");
      const line = h("p", { class: "card-desc card-note", text: note });
      if (existing) existing.replaceWith(line); else card.append(line);
    }
    api("/api/respond", { method: "POST", body: { id, result } }).catch((error) => {
      state.error = `回包失败：${error.message}`;
      renderComposer();
    });
  };
  state.pending.set(id, { method, card, settle });

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const picked = new Map();   // qid → Set(labels)
    for (const question of questions) {
      const options = Array.isArray(question.options) ? question.options : [];
      // ⛔ multiple 不在引擎内置 schema 里（那是桌面版动态工具 agent_ask 的扩字段），
      //   所以"能不能多选"两路都认：字段有就用字段，否则看问题文案/选项数兜底（≥2 项即可多选）。
      const multiple = question.multiple === true || question.multiple === "true" || options.length > 1;
      picked.set(question.id, new Set());
      if (question.header) card.append(h("div", { class: "card-desc", text: String(question.header) }));
      card.append(h("p", { class: "card-desc", text: String(question.question || "") }));
      for (const option of options) {
        const label = String(option.label ?? option.id ?? "");
        const button = h("button", {
          type: "button", class: "option",
          "aria-pressed": "false",
          onclick: () => {
            const set = picked.get(question.id);
            if (!multiple) set.clear();
            if (set.has(label)) set.delete(label); else set.add(label);
            for (const sibling of card.querySelectorAll(`.option[data-q="${question.id}"]`)) {
              const active = set.has(sibling.dataset.label);
              sibling.setAttribute("aria-pressed", active ? "true" : "false");
              sibling.querySelector(".mark").textContent = active ? "◉" : "○";
            }
          },
        },
          h("span", { class: "mark", text: "○" }),
          h("span", {}, h("span", { class: "opt-label", text: label }),
            option.description ? h("span", { class: "opt-desc", text: String(option.description) }) : null),
        );
        button.dataset.q = String(question.id);
        button.dataset.label = label;
        button.style.display = "flex";
        button.querySelector(".opt-desc")?.style.setProperty("display", "block");
        card.append(button);
      }
    }
    const submit = h("button", {
      type: "button", class: "btn primary", text: "提交",
      onclick: () => {
        // ⛔ 两层结构：{ answers: { <qid>: { answers: string[] } } }（ToolRequestUserInputResponse）
        const answers = {};
        for (const [qid, set] of picked) answers[qid] = { answers: [...set] };
        settle({ answers }, `已作答：${[...picked.values()].map((s) => [...s].join("+") || "（空）").join("；")}`);
      },
    });
    card.append(h("div", { class: "actions" }, submit));
    streamAppend(card);
    return;
  }

  if (method.includes("elicitation")) {
    const message = String(params.message || params.elicitation?.message || "");
    if (message) card.append(h("p", { class: "card-desc", text: message }));
    card.append(h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", text: "接受", onclick: () => settle({ action: "accept" }, "已接受") }),
      h("button", { type: "button", class: "btn ghost", text: "取消", onclick: () => settle({ action: "cancel" }, "已取消") }),
    ));
    streamAppend(card);
    return;
  }

  // 审批类：命令 / 文件改动 / 权限
  if (params.command) card.append(h("pre", { class: "card-code", text: String(params.command) }));
  if (params.cwd) card.append(h("p", { class: "card-desc", text: `工作目录：${params.cwd}` }));
  if (params.reason) card.append(h("p", { class: "card-desc", text: String(params.reason) }));
  if (Array.isArray(params.permissions)) card.append(h("pre", { class: "card-code", text: safeJson(params.permissions) }));
  card.append(h("div", { class: "actions" },
    h("button", { type: "button", class: "btn primary", text: "允许", onclick: () => settle({ decision: "accept" }, "已允许") }),
    h("button", { type: "button", class: "btn danger", text: "拒绝", onclick: () => settle({ decision: "decline" }, "已拒绝") }),
  ));
  streamAppend(card);
}

/** 回合结束时释放该会话所有阻塞式卡片：先给引擎一份合法回包，再摘卡（回包失败也摘）。 */
function releasePending(threadId, reason) {
  for (const [id, entry] of [...state.pending]) {
    entry.settle(declineResultFor(entry.method), `回合已结束（${reason.replace("turn/", "")}），这张卡自动作废`);
  }
  scheduleStick();
}

/* ── 渲染骨架 ─────────────────────────────────────────────────────────────── */
let dom = null;

function buildDom() {
  const railList = h("div", { class: "rail-list", id: "chc-threads" });
  const streamInner = h("div", { class: "stream-inner", id: "chc-stream" });
  const stream = h("div", { class: "stream", id: "chc-scroll", onclick: () => { if (window.innerWidth <= 720) document.querySelector(".app").classList.remove("rail-open"); } }, streamInner);
  const title = h("div", { class: "title", text: "新会话", id: "chc-title" });
  const pills = h("div", { class: "pill", id: "chc-status" }, h("span", { class: "dot" }), h("span", { text: "连接中" }));
  const composerRow = h("div", { class: "composer-row" });
  const hint = h("div", { class: "hint", id: "chc-hint", text: "" });
  const sendBtn = h("button", { type: "button", class: "btn primary", text: "发送", id: "chc-send" });
  const stopBtn = h("button", { type: "button", class: "btn danger", text: "停止", id: "chc-stop" });
  const textarea = h("textarea", { placeholder: "说点什么…（Ctrl/⌘ + Enter 发送）", rows: "3", id: "chc-input" });
  composerRow.append(hint, stopBtn, sendBtn);

  // 稳定 id：自动化验收（scripts/shot.mjs）靠它们定位，改名前先想清楚谁来点
  const newBtn = h("button", { type: "button", class: "btn ghost", text: "＋ 新建会话", id: "chc-new" });
  const themeBtn = h("button", { type: "button", class: "btn icon ghost", title: "切换主题", text: "◐", id: "chc-theme" });
  const railToggle = h("button", { type: "button", class: "btn icon ghost rail-toggle", text: "☰", id: "chc-rail-toggle" });
  const railEmpty = h("div", { class: "rail-empty", text: "还没有会话" });
  const railFoot = h("div", { class: "rail-foot" }, h("div", { class: "note", id: "chc-note" }));

  const rail = h("aside", { class: "rail" },
    h("div", { class: "rail-head" }, h("div", { class: "brand" }, "Codex Harness", h("em", { text: "Cloud" }))),
    newBtn, railList, railEmpty, railFoot,
  );

  const topbar = h("div", { class: "topbar" }, railToggle, title, h("div", { class: "spacer" }), pills, themeBtn);
  const main = h("div", { class: "main" }, topbar, stream, h("div", { class: "composer" }, h("div", { class: "composer-inner" }, textarea, composerRow)));
  const app = h("div", { class: "app" }, rail, main);
  // 配对 / 错误面板作为浮层挂上去
  const overlay = h("div", { hidden: true });
  document.body.append(app, overlay);

  dom = { app, overlay, rail, railList, railEmpty, railFoot, railToggle, stream, streamInner, title, pills, textarea, sendBtn, stopBtn, hint, newBtn, themeBtn };

  newBtn.addEventListener("click", () => createThread());
  sendBtn.addEventListener("click", () => send());
  stopBtn.addEventListener("click", () => interrupt());
  themeBtn.addEventListener("click", toggleTheme);
  railToggle.addEventListener("click", () => app.classList.toggle("rail-open"));
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); send(); }
  });
  textarea.addEventListener("input", autoGrow);
}

function autoGrow() {
  const el = dom.textarea;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function streamAppend(node) { dom.streamInner.append(node); }

/** 贴底：只在用户本来就在底部时跟随 —— 否则用户往上翻历史会被新消息拽下来。 */
let stickQueued = false;
function scheduleStick() {
  if (stickQueued) return;
  stickQueued = true;
  requestAnimationFrame(() => {
    stickQueued = false;
    const el = dom && dom.stream;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || state.running) el.scrollTop = el.scrollHeight;
  });
}

/* ── 渲染 ─────────────────────────────────────────────────────────────────── */
function render() {
  if (!state.ready) return;
  if (state.pairing) { renderPairing(); return; }
  dom.overlay.hidden = true;
  renderThreads();
  renderTitle();
  renderPills();
  renderComposer();
}

function renderPills() {
  if (!dom) return;
  const engine = state.server.engine || {};
  const connected = state.connected;
  const status = connected
    ? (engine.status === "ready" ? (state.server.mock ? "假引擎（演示）" : "引擎就绪") : `引擎：${engine.status || "未知"}`)
    : "正在重连…";
  const level = !connected ? "warn" : engine.status === "ready" ? "ok" : engine.status === "error" ? "bad" : "warn";
  clear(dom.pills);
  dom.pills.className = `pill ${level}`;
  dom.pills.append(h("span", { class: "dot" }), h("span", { text: status }));
  if (state.server.capabilities && state.server.capabilities.cdnBase) {
    dom.railFoot.querySelector(".note").textContent =
      `协议 v${state.server.protocolVersion}｜界面资源：${state.server.capabilities.cdnBase}｜数据与执行都在本机`;
  }
}

function renderThreads() {
  if (!dom) return;
  clear(dom.railList);
  dom.railEmpty.hidden = state.threads.length > 0;
  for (const thread of state.threads) {
    const item = h("button", {
      type: "button",
      class: `thread-item${thread.id === state.activeThreadId ? " active" : ""}`,
      onclick: () => openThread(thread.id),
    },
      h("span", { class: "name", text: thread.name || thread.id }),
      h("span", { class: "meta", text: `${timeLabel(thread.updatedAt || thread.createdAt)} ${shortId(thread.id)}` }),
    );
    dom.railList.append(item);
  }
}

function renderTitle() {
  const thread = state.threads.find((t) => t.id === state.activeThreadId);
  dom.title.textContent = thread ? (thread.name || thread.id) : "新会话";
}

function renderComposer() {
  if (!dom) return;
  dom.sendBtn.disabled = state.running;
  dom.stopBtn.hidden = !state.running;
  dom.hint.textContent = state.error
    ? state.error
    : state.running
      ? "正在运行，可随时停止"
      : state.activeThreadId ? "" : "回车换行，Ctrl/⌘ + Enter 发送";
  dom.hint.style.color = state.error ? "var(--red)" : "";
}

function renderPairing() {
  const overlay = dom.overlay;
  clear(overlay);
  overlay.hidden = false;
  const input = h("input", {
    type: "text", placeholder: "输入控制台上的配对码（8 位十六进制）",
    class: "card-code", style: { width: "100%", padding: "9px 11px" },
    value: state.raw,
  });
  const message = h("p", { class: "card-desc", text: state.error || "" });
  const submit = h("button", {
    type: "button", class: "btn primary", text: "配对",
    onclick: () => pair(input.value.trim().toLowerCase(), message),
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
  overlay.append(h("div", {
    id: "chc-pairing", class: "card", style: {
      position: "fixed", inset: "auto", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
      width: "min(420px, calc(100vw - 32px))", zIndex: "30",
    },
  },
    h("div", { class: "card-title" }, h("span", { text: "与本机伴生服务配对" })),
    h("p", { class: "card-desc", text: "打开本地伴生服务的那个控制台窗口，把上面打印的配对码填进来。配对码 5 分钟内有效、且只能用一次。" }),
    input, message, h("div", { class: "actions" }, submit),
  ));
  input.focus();
}

/* ── 主题 ─────────────────────────────────────────────────────────────────── */
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(LS.theme, next); } catch { /* 忽略 */ }
}

/* ── 动作 ─────────────────────────────────────────────────────────────────── */
async function pair(code, messageEl) {
  state.error = "";
  if (!code) { state.error = "请先填配对码"; renderPairing(); return; }
  try {
    const result = await api("/api/pair", { method: "POST", body: { code }, auth: false });
    if (!result || !result.token) throw new Error("配对响应异常");
    state.token = result.token;
    try { localStorage.setItem(LS.token, result.token); } catch { /* 忽略 */ }
    state.pairing = false;
    await boot();
  } catch (error) {
    state.error = error.message === "mismatch" ? "配对码不对"
      : error.message === "expired" ? "配对码已过期，请重启伴生服务拿新的"
      : error.message === "too-many-tries" ? "尝试次数过多，请重启伴生服务"
      : error.message;
    if (messageEl && messageEl.isConnected) messageEl.textContent = state.error;
    else render();
  }
}

async function refreshThreads() {
  const result = await rpc("thread/list", {});
  const list = Array.isArray(result && result.result && result.result.data) ? result.result.data : [];
  state.threads = list.map((t) => ({
    id: String(t.id || ""),
    name: String(t.name || t.title || ""),
    updatedAt: Number(t.updatedAt || t.createdAt || 0) || 0,
    createdAt: Number(t.createdAt || 0) || 0,
  })).filter((t) => t.id);
}

async function createThread() {
  if (!state.activeThreadId) {
    // 已有一个空会话就别再建了
    state.activeThreadId = state.activeThreadId || "";
  }
  const result = await rpc("thread/start", {});
  const thread = result && result.result && result.result.thread;
  if (!thread || !thread.id) throw new Error("thread/start 没有返回会话");
  state.threads.unshift({ id: String(thread.id), name: thread.name || "新会话", updatedAt: Date.now(), createdAt: Date.now() });
  state.activeThreadId = String(thread.id);
  try { localStorage.setItem(LS.thread, state.activeThreadId); } catch { /* 忽略 */ }
  clear(dom.streamInner);
  state.items.clear();
  state.pending.forEach((entry) => entry.settle(declineResultFor(entry.method), "已切换会话"));
  state.pending.clear();
  render();
  return state.activeThreadId;
}

async function openThread(threadId) {
  if (!threadId || threadId === state.activeThreadId) return;
  state.pending.forEach((entry) => entry.settle(declineResultFor(entry.method), "已切换会话"));
  state.pending.clear();
  state.activeThreadId = threadId;
  state.turnId = "";
  state.running = false;
  try { localStorage.setItem(LS.thread, threadId); } catch { /* 忽略 */ }
  try { await rpc("thread/resume", { threadId }); } catch (error) { state.error = `会话恢复失败：${error.message}`; }
  clear(dom.streamInner);
  state.items.clear();
  render();
}

async function send() {
  const text = dom.textarea.value.trim();
  if (!text || state.running) return;
  dom.textarea.value = "";
  autoGrow();
  state.error = "";
  try {
    if (!state.activeThreadId) await createThread();
    await rpc("turn/start", { threadId: state.activeThreadId, input: [{ type: "text", text, text_elements: [] }] });
    state.running = true;
    renderComposer();
  } catch (error) {
    state.error = `发送失败：${error.message}`;
    renderComposer();
  }
}

async function interrupt() {
  if (!state.activeThreadId) return;
  try {
    // ⛔ 先摘卡再发中断：即使 turn/interrupt 自己失败（回合其实已经结束），
    //   界面上也不会留下等不到答复的死卡 —— 与桌面版同一处理顺序。
    releasePending(state.activeThreadId, "turn/interrupt");
    await rpc("turn/interrupt", { threadId: state.activeThreadId, ...(state.turnId ? { turnId: state.turnId } : {}) });
  } catch (error) {
    state.error = `停止失败：${error.message}`;
  }
  state.running = false;
  state.turnId = "";
  renderComposer();
}

/* ── 启动 ─────────────────────────────────────────────────────────────────── */
/**
 * 第一帧渲染完成就置位 `__chcReady`。
 * ⛔ 必须在**每条**启动分支上都调用：外壳里那个 4 秒兜底定时器（云端资产拿不到就切本地副本）
 *   读的正是这个标志。走配对分支时忘了置位 ⇒ 兜底会在 4 秒后**再插一个 app.js**，
 *   界面被初始化两次（同一份状态建两套 DOM、事件流也开两条）——
 *   这类"看起来随机抽风"的 bug 极难从代码上想到，是走查台逮出来的。
 */
function markReady() {
  window.__chcReady = true;
  clearTimeout(window.__chcFallbackTimer);
  // 收掉外壳自带的首屏提示。⛔ 由 JS 收、不靠 styles.css 里的 `#boot{display:none}`：
  //   样式表本身也可能没到（云端选了但抓不下来），那条规则就一起失效了。
  try { window.__chcHideBoot && window.__chcHideBoot(); } catch { /* 忽略 */ }
}

async function boot() {
  const handshake = await api("/api/handshake");
  state.server = {
    protocolVersion: Number(handshake.protocolVersion || 0),
    agentVersion: String(handshake.agentVersion || ""),
    mock: Boolean(handshake.mock),
    engine: handshake.engine || {},
    capabilities: handshake.capabilities || {},
  };
  if (state.server.protocolVersion !== PROTOCOL_VERSION) {
    state.error = `协议不匹配：界面 v${PROTOCOL_VERSION} vs 伴生服务 v${state.server.protocolVersion}，请更新较旧的一方`;
  }
  await refreshThreads();
  if (!state.activeThreadId) {
    const remembered = localStorage.getItem(LS.thread);
    if (remembered && state.threads.some((t) => t.id === remembered)) state.activeThreadId = remembered;
    else if (state.threads.length) state.activeThreadId = state.threads[0].id;
  }
  state.ready = true;
  state.pairing = false;
  render();
  streamEvents();
}

async function main() {
  // ⛔ 二次初始化守卫：外壳的云端资产回落有两条触发路径（script onerror + 4 秒超时），
  //   两条都可能在极端情况下各插一次 app.js —— 那份脚本会再跑一遍 main()，
  //   于是同一个窗口里出现两套 DOM、两条事件流。走查实测撞到过，代价是
  //   "看起来随机抽风"的一整类 bug。这里做一次性门闩，重复进入直接退出。
  if (window.__chcAppStarted) return;
  window.__chcAppStarted = true;
  buildDom();
  const params = new URLSearchParams(location.search);
  const code = params.get("pair");
  try { state.token = localStorage.getItem(LS.token) || ""; } catch { state.token = ""; }

  if (code) {
    // 从控制台带参进来：换 token 后把 URL 上的配对码抹掉（别留在历史记录里）
    history.replaceState(null, "", location.pathname);
    state.pairing = true;
    state.ready = true;
    render();
    markReady();
    await pair(code.toLowerCase());
    return;
  }

  if (!state.token) { state.ready = true; state.pairing = true; render(); markReady(); return; }
  try {
    await boot();
  } catch (error) {
    if (error.status === 401) { state.token = ""; try { localStorage.removeItem(LS.token); } catch { /* 忽略 */ } state.pairing = true; }
    else { state.pairing = true; state.error = error.message; }
    state.ready = true;
    render();
  }
  markReady();
}

main().catch((error) => {
  console.error("[chc] 启动失败", error);
});
