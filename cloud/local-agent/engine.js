"use strict";
/**
 * Codex Harness Cloud · 本地伴生服务 —— 真实引擎适配
 *
 * 引擎就是桌面版用的同一个 `codex app-server`（stdio 上的 JSON-RPC 行协议），
 * 这里把它包成"可被 HTTP/SSE 转发"的事件源。与桌面版 `electron/codex-server.ts` 是
 * **同一套协议、同一套硬约束**，但刻意做窄：云版不需要桌面版的全部能力（自更新、
 * rollout 增强、工具面改写都在桌面侧），这里只保留"能跑一轮对话"所必需的部分。
 *
 * ⛔⛔ 三条从桌面版事故里换来的硬约束，一条都不能省：
 *   ① **respawn 前必须等旧进程真的退出**（引擎 0.157 起启动时初始化 sqlite state runtime，
 *      两个进程重叠会让新的那个以 `failed to initialize sqlite state runtime under …` 直接 exit 1）。
 *   ② spawn 要带 `-c project_doc_max_bytes=262144`（默认 32768，AGENTS.md 超限会被**静默截断**）。
 *   ③ 只处理"仍是当前那个 child"的 exit/error —— 旧进程的迟到事件会把新进程误判成已死，
 *      再叠加一个引擎进程上去（同一份 codex-home 两个引擎抢索引）。
 */
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");

const INITIALIZE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** 引擎退出后多久重启；指数退避封顶，避免坏配置时无限快速重启刷爆 codex-home。 */
const RESTART_BACKOFF_MS = [500, 1_500, 4_000, 10_000, 20_000];
/** 等旧进程落地的上限（超时也继续，但会记一条 warn —— 绝不能无限等）。 */
const EXIT_WAIT_MS = 4_000;

class EngineAdapter extends EventEmitter {
  /**
   * @param {{ binary: string, codexHome: string, cwd: string, extraEnv?: Record<string,string>, log: (msg:string)=>void }} options
   */
  constructor(options) {
    super();
    this.binary = options.binary;
    this.codexHome = options.codexHome;
    this.cwd = options.cwd;
    this.extraEnv = options.extraEnv || {};
    this.log = options.log || (() => {});
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.starting = null;
    this.launching = false;
    this.launchToken = 0;
    this.stopping = false;
    this.restartAttempt = 0;
    this.restartTimer = null;
    this.statusValue = { status: "idle" };
  }

  get status() {
    return this.statusValue;
  }

  setStatus(status, message) {
    this.statusValue = { status, message };
    this.emit("event", { kind: "status", status, message });
  }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  async launch() {
    const token = ++this.launchToken;
    this.launching = true;
    try {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.launchOnce();
          this.restartAttempt = 0;
          return;
        } catch (error) {
          lastError = error;
          if (this.stopping || token !== this.launchToken) throw error;
          if (attempt < 3) {
            this.log(`[engine] 启动失败（第 ${attempt}/3 次）：${error.message}`);
            await new Promise((r) => setTimeout(r, 600 * attempt));
            if (token !== this.launchToken) throw lastError;
          }
        }
      }
      this.setStatus("error", lastError && lastError.message);
      throw lastError;
    } finally {
      if (token === this.launchToken) this.launching = false;
    }
  }

  async launchOnce() {
    if (!this.binary) throw new Error("找不到 Codex 引擎二进制（可用 HARNESS_CODEX_BINARY 指定）");
    this.setStatus("starting");
    // ⛔ 引擎要求 CODEX_HOME **已经存在**：目录缺失时它会
    //   `Error: CODEX_HOME points to "…", but that path does not exist` 直接 exit 1
    //   （实测踩到，症状是"引擎起不来且只报退出码 1"）。它自己不会创建这个目录。
    fs.mkdirSync(this.codexHome, { recursive: true });
    const env = {
      ...process.env,
      ...this.extraEnv,
      CODEX_HOME: this.codexHome,
      // 官方内部开关（不在 --help 里）：关掉 remote control 轮询。它只对 ChatGPT 登录态有意义，
      // 拿 API key 跑时 websocket 会每秒重试解析偏好，实测占引擎日志 95%。
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    };
    const child = spawn(
      this.binary,
      ["-c", "project_doc_max_bytes=262144", "app-server", "--listen", "stdio://"],
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env }
    );
    this.child = child;
    this.log(`[engine] spawn pid=${child.pid} binary=${this.binary} CODEX_HOME=${this.codexHome}`);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log(`[engine:stderr] ${text.slice(0, 600)}`);
    });
    // ⛔ 约束③：只认"仍是当前 child"的事件
    child.on("error", (error) => {
      if (this.child === child) this.fail(error);
      else this.log(`[engine] 过期进程 error（忽略）：${error.message}`);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.fail(new Error(`引擎退出（code=${code == null ? "unknown" : code}）`));
      else this.log(`[engine] 过期进程 exit（忽略）code=${code == null ? "unknown" : code}`);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "codex_harness_cloud", title: "Codex Harness Cloud", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, INITIALIZE_TIMEOUT_MS);
    this.notify("initialized", {});
    this.setStatus("ready");
  }

  fail(error) {
    const wasRunning = Boolean(this.child);
    this.child = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      try { reject(error); } catch { /* 已 settle */ }
    }
    this.pending.clear();
    this.setStatus("error", error.message);
    if (this.stopping) return;
    // 启动序列进行中由 launch() 自己重试，这里直接返回（否则会叠加两个 spawn）
    if (this.launching) return;
    if (!wasRunning) return;
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartAttempt += 1;
    this.log(`[engine] ${delay}ms 后自动重启（第 ${this.restartAttempt} 次）`);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.start().catch((e) => this.log(`[engine] 自动重启失败：${e.message}`));
    }, delay);
  }

  /** 主动停止：摘掉 exit/error 监听再 kill，否则退出路径会被 fail() 自动拉起（桌面版 09-13 P0）。 */
  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const dying = this.child;
    this.child = null;
    if (!dying) return;
    dying.removeAllListeners("exit");
    dying.removeAllListeners("error");
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.log("[engine] 等待退出超时，继续（约束①的兜底）");
        finish();
      }, EXIT_WAIT_MS);
      dying.once("exit", finish);
      try { dying.kill(); } catch { finish(); }
    });
    this.setStatus("stopped");
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (method !== "initialize" && !this.child) {
      // 未启动就先拉起（第一次调用可能是 thread/list）。拉起失败直接抛，调用方能看到真因。
      return this.start().then(() => this.request(method, params, timeoutMs));
    }
    if (!this.child) return Promise.reject(new Error("引擎未运行"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  write(message) {
    if (!this.child || !this.child.stdin.writable) throw new Error("引擎不可用");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`[engine:raw] ${line.slice(0, 300)}`);
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    // 引擎反向请求（审批 / 询问 / elicitation）：带 id 且带 method
    if (message.id !== undefined && message.method) {
      this.emit("event", { kind: "request", id: message.id, method: message.method, params: message.params });
      return;
    }
    if (message.method) this.emit("event", { kind: "notification", method: message.method, params: message.params });
  }
}

module.exports = { EngineAdapter };
