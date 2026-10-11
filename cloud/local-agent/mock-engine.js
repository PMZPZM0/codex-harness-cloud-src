"use strict";
/**
 * Codex Harness Cloud · 本地伴生服务 —— 假引擎（自测 / 演示）
 *
 * 为什么需要它：真引擎跑一轮要模型 key + 网络 + 真花钱，而"协议接线对不对"这件事
 * 与模型无关。这里用一段**确定性脚本**扮演引擎，把一条最容易出错的路走全：
 *   流式正文 → 询问卡（多选）→ 工具执行 → 审批卡 → 收尾
 * 于是 smoke.mjs 可以断言"事件顺序 / 卡片参数 / 回包形状 / 中断语义"，而断言失败
 * 一定是我们自己的 bug，不会跟上游模型的随机行为混淆。
 *
 * ⛔ 接口与 EngineAdapter 完全一致（start/stop/request/respond/status/on("event")），
 *   所以 server.js 对"真假引擎"无感 —— 换引擎 = 换一个对象，别在路由里写分支。
 */
const { EventEmitter } = require("node:events");

const STEP_MS = Number(process.env.MOCK_ENGINE_STEP_MS || 260);

class MockEngine extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.threads = new Map();
    this.nextThread = 1;
    this.nextRequestId = 9000;
    this.activeTurn = null;
    this.pendingRequests = new Map();   // id → { resolve-continuation }
    this.statusValue = { status: "idle" };
    this.turnSeq = 0;
  }

  get status() {
    return this.statusValue;
  }

  async start() {
    this.statusValue = { status: "ready" };
    this.emit("event", { kind: "status", status: "ready" });
  }

  async stop() {
    this.statusValue = { status: "stopped" };
    this.emit("event", { kind: "status", status: "stopped" });
  }

  emitEvent(event) {
    this.emit("event", event);
  }

  notify(method, params) {
    this.emitEvent({ kind: "notification", method, params });
  }

  /** 引擎→客户端请求：返回一个 promise，等客户端 respond 或被中断时 settle。 */
  askClient(method, params) {
    const id = this.nextRequestId++;
    this.emitEvent({ kind: "request", id, method, params });
    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
    });
  }

  respond(id, result) {
    const resolve = this.pendingRequests.get(id);
    if (!resolve) return;      // 重复回包 / 回合已被中断：静默丢弃（真引擎同样会忽略过期 id）
    this.pendingRequests.delete(id);
    resolve(result);
  }

  settleAllPending(reason) {
    for (const [id, resolve] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      resolve({ __aborted: reason, id });
    }
  }

  async request(method, params) {
    switch (method) {
      case "thread/list":
        return { data: [...this.threads.values()].map((t) => ({
          id: t.id, name: t.name, cwd: t.cwd, updatedAt: t.updatedAt, createdAt: t.createdAt,
        })) };
      case "thread/start": {
        const id = `mock-thread-${String(this.nextThread++).padStart(3, "0")}`;
        const thread = {
          id, name: "新会话", cwd: params && params.cwd ? params.cwd : process.cwd(),
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        this.threads.set(id, thread);
        return { thread };
      }
      case "thread/resume": {
        const id = String((params && params.threadId) || "");
        const thread = this.threads.get(id) || { id, name: "（未知会话）", cwd: process.cwd(), createdAt: Date.now(), updatedAt: Date.now() };
        this.threads.set(id, thread);
        return { thread };
      }
      case "thread/unsubscribe":
        return {};
      case "turn/start": {
        const threadId = String((params && params.threadId) || "");
        const turnId = `mock-turn-${++this.turnSeq}`;
        // 不 await：与真引擎一致 —— turn/start 立刻返回，后续走通知流
        this.runTurn(threadId, turnId, params).catch((error) => {
          this.notify("turn/failed", { threadId, turnId, error: { message: error.message } });
        });
        return { turn: { id: turnId } };
      }
      case "turn/interrupt": {
        this.abortActive("interrupt");
        return {};
      }
      default:
        throw new Error(`mock 引擎未实现的方法：${method}`);
    }
  }

  abortActive(reason) {
    if (!this.activeTurn) return;
    this.activeTurn.aborted = reason;
    this.settleAllPending(reason);
    const { threadId, turnId } = this.activeTurn;
    this.activeTurn = null;
    const method = reason === "interrupt" ? "turn/interrupted" : "turn/aborted";
    // ⛔ 形状照协议：回合类通知一律 `{ threadId, turn: { id, status } }`，
    //   `turnId` 只是桌面渲染层的**容错读法**（`params.turn?.id ?? params.turnId`）。
    //   假引擎必须给真形状，否则自测会放过"客户端只读 turnId"这类 bug。
    this.notify(method, { threadId, turn: { id: turnId, status: reason === "interrupt" ? "interrupted" : "aborted" } });
  }

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
    if (this.activeTurn && this.activeTurn.aborted) throw new Error("__aborted");
  }

  async runTurn(threadId, turnId, params) {
    const thread = this.threads.get(threadId);
    if (thread) { thread.updatedAt = Date.now(); }
    const turn = { threadId, turnId, aborted: null };
    this.activeTurn = turn;

    const userText = extractText(params && params.input);
    const item = (suffix) => `${turnId}-${suffix}`;
    const turnRef = { id: turnId, status: "inProgress" };

    this.notify("turn/started", { threadId, turn: turnRef });

    // ① 用户消息回显（与真引擎一致：userMessage 走 item/*，回合容器不带它）
    const userItem = { id: item("user"), type: "userMessage", content: (params && params.input) || [] };
    this.notify("item/started", { threadId, turnId, item: userItem });
    this.notify("item/completed", { threadId, turnId, item: userItem });

    // ② 推理行（让界面有"正在思考"的着落）。reasoning item 的形状：content/summary 都是字符串数组
    this.notify("item/started", { threadId, turnId, item: { id: item("reason"), type: "reasoning", content: [], summary: [] } });
    await this.sleep(STEP_MS);
    this.notify("item/completed", {
      threadId, turnId,
      item: { id: item("reason"), type: "reasoning", content: [], summary: ["收到需求，先确认一件事再动手。"] },
    });

    // ③ 询问卡：多选题 —— 正是本期修过的 multiple 那条链路的活体样本
    // ⛔ 关于 `multiple`：引擎内置 `request_user_input` 的协议 schema 里**没有**这个字段
    //   （见 ToolRequestUserInputParams.json：只有 header/id/question/options/isOther/isSecret），
    //   桌面版是靠**自己的动态工具** `agent_ask` 扩出 `multiple` 的。所以这里同时做两件事：
    //   ① 带上 `multiple`（客户端有就按多选渲染）；② 在 question 文案里写明「可多选」——
    //   后者才是模型实际会用的表达方式。两路都覆盖，客户端缺一路也还能用。
    const askResult = await this.askClient("item/tool/requestUserInput", {
      threadId, turnId,
      questions: [{
        id: "scope",
        header: "改动范围",
        question: `要处理「${userText.slice(0, 40)}」，这次动到哪一层？（可多选）`,
        multiple: true,
        options: [
          { id: "ui", label: "界面层", description: "样式 / 布局 / 交互表现" },
          { id: "logic", label: "业务逻辑", description: "数据处理与流程" },
          { id: "infra", label: "构建与发布", description: "打包、CI、部署脚本" },
        ],
      }],
    });
    if (askResult && askResult.__aborted) throw new Error("__aborted");

    // ④ 工具执行（命令）。commandExecution 的必填字段：command / commandActions / cwd / status
    const cwd = thread ? thread.cwd : process.cwd();
    this.notify("item/started", {
      threadId, turnId,
      item: { id: item("cmd"), type: "commandExecution", command: "npm run check", commandActions: [], cwd, status: "inProgress" },
    });
    await this.sleep(STEP_MS);

    // ⑤ 审批卡
    const approval = await this.askClient("item/commandExecution/requestApproval", {
      threadId, turnId, command: "npm run check", cwd, reason: "运行项目预检链",
    });
    if (approval && approval.__aborted) throw new Error("__aborted");
    const decision = approval && approval.decision ? approval.decision : "decline";
    this.notify("item/completed", {
      threadId, turnId,
      item: {
        id: item("cmd"), type: "commandExecution", command: "npm run check", commandActions: [], cwd,
        status: decision === "accept" ? "completed" : "declined",
        exitCode: decision === "accept" ? 0 : null,
        aggregatedOutput: decision === "accept" ? "预检通过：19 项环境基线失败，无新增红。" : "用户拒绝了本次执行。",
      },
    });

    // ⑥ 流式正文：带真实 Markdown（标题 / 列表 / 代码块 / 引用）——
    //    Web 端的 .markdown 渲染与复制按钮要靠它才能在走查图里被验证
    this.notify("item/started", { threadId, turnId, item: { id: item("msg"), type: "agentMessage", text: "" } });
    const answer = decision === "accept"
      ? [
        `已按你选的「${answerLabels(askResult)}」范围处理：预检跑完，**没有新增红灯**。`,
        "",
        "## 结果",
        "",
        "- 环境类失败 **19 项**，与已知基线一致（沙箱封锁子进程 / 缺 python）",
        "- 尾部补跑的三项全部通过：bag-types / dead-imports / require-paths",
        "- 产物已重建，界面刷新即可看到",
        "",
        "```bash",
        "npm run check        # 19 项环境基线失败，无新增红",
        "node scripts/check-bag-types.mjs   # Bag 1392 / 1392，0 mismatch",
        "```",
        "",
        "> 提示：云端版与桌面版共用同一套协议；回包形状全部照 schema 抄，两边行为一致。",
      ].join("\n")
      : [
        `你拒绝了那次命令执行，我把结论按现有信息给出：范围是「${answerLabels(askResult)}」。`,
        "",
        "## 现状",
        "",
        "- 未执行任何验证命令",
        "- 结论基于既有信息，**未经实测**",
        "",
        "需要我再跑一次时，重新发起即可 —— 审批卡会再次弹出。",
      ].join("\n");
    for (const chunk of chunkText(answer, 6)) {
      await this.sleep(Math.max(30, STEP_MS / 4));
      this.notify("item/agentMessage/delta", { threadId, turnId, itemId: item("msg"), delta: chunk });
    }
    this.notify("item/completed", { threadId, turnId, item: { id: item("msg"), type: "agentMessage", text: answer } });

    this.activeTurn = null;
    this.notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  }
}

function extractText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((part) => (part && part.type === "text" ? String(part.text || "") : "")).join("").trim();
  }
  return "";
}

/**
 * 从 requestUserInput 的回包里取标签（只为让正文读起来像那么回事）。
 * ⛔ 协议真形状是**两层 answers**：`{ answers: { <qid>: { answers: string[] } } }`
 *   （见 codex-schema/ToolRequestUserInputResponse.json），别写成一层的字符串数组。
 */
function answerLabels(result) {
  const outer = (result && result.answers) || {};
  const out = [];
  for (const value of Object.values(outer)) {
    if (value && Array.isArray(value.answers)) out.push(...value.answers);
    else if (Array.isArray(value)) out.push(...value);
    else if (typeof value === "string") out.push(value);
  }
  return out.length ? out.join(" + ") : "（未作答）";
}

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

module.exports = { MockEngine, STEP_MS };
