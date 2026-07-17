<div align="center">

# sgagent

**A minimal, self-contained coding agent CLI.**  
OpenAI-compatible · streaming · default MiMo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.12.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)

**[English](#english)** · **[中文](#中文)**

</div>

---

## English

> The repository is hosted as [`yangjie-ai/fagent`](https://github.com/yangjie-ai/fagent); the CLI / package name is **sgagent**.

### What is sgagent?

sgagent is a tiny terminal coding agent. It can read, write, and edit files, run shell commands, and search a codebase — driven by any OpenAI-compatible chat model (it ships configured for [MiMo](https://www.xiaomimimo.com/) out of the box).

It is **fully self-contained**: the [`pi-agent-core`](https://github.com/earendil-works/pi) (agent harness) and [`pi-ai`](https://github.com/earendil-works/pi) (model layer) source is **vendored** into [`src/agent`](./src/agent) and [`src/ai`](./src/ai), aliased through `tsconfig` `paths` (`@earendil-works/*` → local source). There are **no external pi npm dependencies** — `git clone` + `npm install` and you're running.

sgagent was built to study and borrow from Pi's context-management design — specifically to fix the classic failure mode where *a single `read` blow up the whole context window*. The tool layer enforces per-call output truncation and paging (see [How it works](#how-it-works)).

### Features

- **7 coding tools with context discipline** — `read` truncates to 2000 lines / 50 KB (whichever hits first) and supports `offset`/`limit` paging; `bash` keeps the tail. One tool call can no longer fill the context.
- **Multi-project workspaces** — all state (sessions, traces) lives in `~/.fagent`, keyed per project. Switch projects with `--workspace`; the target project directory stays clean (no `.sessions/` or `data/` pollution).
- **Persistent sessions + resume** — every project's conversation history is persisted to JSONL; on start you can pick a past session and the text thread is replayed.
- **Model + tool traces + browser viewer** — every loop streams model and tool traces to disk; `npm run view` serves a local page to inspect them.
- **Streaming with reasoning** — live token streaming, including thinking/reasoning content for reasoning models.
- **Resilient calls** — automatic retry with a classifier + exponential backoff (covers 4xx/5xx).

### Requirements

- **Node.js ≥ 20.12.0** (uses `process.loadEnvFile(path)`).

### Quick start

```bash
git clone https://github.com/yangjie-ai/fagent.git
cd fagent
npm install
printf 'API_KEY=your-key\n' > .env
npm start
```

Then just type a question at the `> ` prompt. Type `exit` to quit.

### Configuration

sgagent reads environment variables, loaded from two `.env` files in order (later wins):

1. Global: `~/.fagent/.env` (shared LLM config across projects)
2. Project: `./.env` in the active workspace (project-specific overrides)

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | *(required)* | API key for the OpenAI-compatible endpoint. |
| `BASE_URL` | `https://api.xiaomimimo.com/v1` | Endpoint base URL. Point at any compatible backend. |
| `MODEL_ID` | `mimo-v2.5` | Model id. |
| `REASONING` | `true` | Whether the model supports thinking / `reasoning_content`. Set `false` for non-reasoning models. |
| `CONTEXT_WINDOW` | `1048576` | Model context window (tokens). |
| `MAX_TOKENS` | `131072` | Max output tokens per response. |
| `FAGENT_HOME` | `~/.fagent` | Root for all state (sessions + traces), organized per workspace. |
| `VIEW_PORT` | `4789` | Port for the trace viewer (`npm run view`). |

### Usage

**REPL** — run `npm start`, type prompts at `> `, `exit` to quit. Token usage is printed after each turn.

**Choosing a workspace** (the project sgagent operates on):

- `npm start` — bare start. If any workspace is known, a **picker** lists them (most-recently-used first); pick one, or `0` for the current directory. With no known workspace, it just uses the current directory.
- `npm start -- --workspace <abs-path>` — switch to a specific project (use **forward slashes**; a *quoted* Windows backslash path is auto-converted `\` → `/`).
- `npm start -- --migrate --workspace <path>` — move an old in-project layout (`<proj>/.sessions`, `<proj>/data`) into `~/.fagent`, then exit.

**Resume** — on start, pick a past session from the history list; its text thread is replayed so you can continue the conversation.

**Viewer** — `npm run view`, then open the printed URL to inspect model/tool traces in the browser.

### Project structure

```
fagent/
├── src/
│   ├── main.ts            # CLI entrypoint (REPL)
│   ├── view.ts            # trace viewer HTTP server
│   ├── config.ts          # workspace resolution (~/.fagent layout)
│   ├── tools/             # 7 coding tools + helpers
│   │   ├── read.ts write.ts edit.ts bash.ts grep.ts ls.ts find.ts
│   │   ├── edit-diff.ts        # edit backing logic
│   │   └── output-accumulator.ts  # streaming + /tmp fallback for bash
│   ├── agent/             # vendored pi-agent-core (harness, session repo, compaction, env)
│   └── ai/                # vendored pi-ai (openai-completions provider, compat streaming, trace)
├── viewer.html            # trace viewer UI
├── scripts/               # runtime tests (tools, workspace)
└── PI_CODING_AGENT_CONTEXT_DESIGN.md   # design notes on context management
```

### Scripts

| Command | What it does |
|---------|--------------|
| `npm start` | Run the agent REPL. |
| `npm run view` | Serve the trace viewer. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test:tools` | Runtime tests for the 7 tools. |
| `npm run test:workspace` | Tests for workspace resolution + state isolation. |

### How it works

sgagent keeps a long-running agent loop from blowing its context through three layers (borrowed from Pi; analyzed in [`PI_CODING_AGENT_CONTEXT_DESIGN.md`](./PI_CODING_AGENT_CONTEXT_DESIGN.md)):

1. **Per-tool output truncation** — *enabled by default.* `read` is capped at 2000 lines / 50 KB with `offset`/`limit` paging; `bash` keeps the tail. This is what stops a single turn from filling the window.
2. **History compaction** — the vendored core can summarize old turns into a structured summary to free space. (Present in the core; **not yet wired into this CLI**.)
3. **Trigger strategy** — when to truncate vs. compact vs. do nothing.

### Acknowledgements

The agent-core and AI layers are vendored from [`earendil-works/pi`](https://github.com/earendil-works/pi) (MIT, © 2025 Mario Zechner). The 7 coding tools are adapted from pi-coding-agent.

### License

[MIT](./LICENSE) © 2026 yangjie-ai

---

## 中文

> 仓库地址是 [`yangjie-ai/fagent`](https://github.com/yangjie-ai/fagent);CLI / 包名是 **sgagent**。

### sgagent 是什么?

sgagent 是一个极简的终端 coding agent。它能读写、编辑文件、跑 shell 命令、搜代码,由任意 OpenAI 兼容的对话模型驱动(开箱默认配 [MiMo](https://www.xiaomimimo.com/))。

它是**完全自包含**的:[`pi-agent-core`](https://github.com/earendil-works/pi)(agent harness)和 [`pi-ai`](https://github.com/earendil-works/pi)(模型层)的源码已 **vendored** 进 [`src/agent`](./src/agent) 和 [`src/ai`](./src/ai),经 `tsconfig` 的 `paths` 别名(`@earendil-works/*` → 本地源)解析。**没有任何外部 pi npm 依赖**——`git clone` + `npm install` 就能跑。

做 sgagent 是为了学习并借鉴 Pi 的上下文管理设计——尤其是解决那个经典痛点:*一次 `read` 就把整个上下文窗口撑爆*。工具层强制了每次调用的输出截断与分页(见[工作原理](#工作原理))。

### 特性

- **7 个 coding 工具 + 上下文纪律** —— `read` 截断到 2000 行 / 50KB(先到为准),支持 `offset`/`limit` 分页;`bash` 保留尾部。单次工具调用不会再把上下文填满。
- **多项目工作区** —— 所有状态(会话、trace)集中在 `~/.fagent`,按项目分桶。用 `--workspace` 切换项目;目标项目目录保持干净(不污染 `.sessions/` 或 `data/`)。
- **会话持久化 + 续聊** —— 每个项目的对话历史落到 JSONL;启动可选历史会话,并回显文本主线。
- **model + tool trace + 浏览器 viewer** —— 每个循环把模型和工具 trace 流式落盘;`npm run view` 起一个本地页面查看。
- **流式输出 + 推理** —— 实时 token 流式,含推理模型的 thinking/reasoning 内容。
- **健壮调用** —— 自动重试 + 分类器 + 指数退避(覆盖 4xx/5xx)。

### 环境要求

- **Node.js ≥ 20.12.0**(用到 `process.loadEnvFile(path)`)。

### 快速开始

```bash
git clone https://github.com/yangjie-ai/fagent.git
cd fagent
npm install
printf 'API_KEY=你的-key\n' > .env
npm start
```

然后在 `> ` 提示符后输入问题。输入 `exit` 退出。

### 配置

sgagent 读取环境变量,按顺序从两个 `.env` 加载(后者覆盖前者):

1. 全局:`~/.fagent/.env`(跨项目共享的 LLM 配置)
2. 项目:当前工作区下的 `./.env`(项目级覆盖)

| 变量 | 默认 | 说明 |
|------|------|------|
| `API_KEY` | *(必填)* | OpenAI 兼容端点的 key。 |
| `BASE_URL` | `https://api.xiaomimimo.com/v1` | 端点 base URL,指向任意兼容后端。 |
| `MODEL_ID` | `mimo-v2.5` | 模型 id。 |
| `REASONING` | `true` | 模型是否支持 thinking / `reasoning_content`。非推理模型设 `false`。 |
| `CONTEXT_WINDOW` | `1048576` | 上下文窗口(token)。 |
| `MAX_TOKENS` | `131072` | 单次响应最大输出 token。 |
| `FAGENT_HOME` | `~/.fagent` | 所有状态根(会话 + trace),按工作区分桶。 |
| `VIEW_PORT` | `4789` | trace viewer 端口(`npm run view`)。 |

### 用法

**REPL** —— 跑 `npm start`,在 `> ` 后输入,`exit` 退出。每轮结束打印 token 用量。

**选择工作区**(sgagent 操作的项目):

- `npm start` —— 裸启动。若有已知工作区,会弹**选择器**(按最近使用排序);选一个,或 `0` 用当前目录。无已知工作区时直接用当前目录。
- `npm start -- --workspace <绝对路径>` —— 切到指定项目(用**正斜杠**;*加引号*的 Windows 反斜杠路径会自动 `\` → `/`)。
- `npm start -- --migrate --workspace <路径>` —— 把老的项目内布局(`<proj>/.sessions`、`<proj>/data`)搬进 `~/.fagent`,然后退出。

**续聊** —— 启动时从历史列表选一条,会回显其文本主线,接着聊。

**viewer** —— `npm run view`,然后打开打印的 URL,在浏览器里查看 model/tool trace。

### 项目结构

```
fagent/
├── src/
│   ├── main.ts            # CLI 入口(REPL)
│   ├── view.ts            # trace viewer HTTP 服务
│   ├── config.ts          # workspace 解析(~/.fagent 布局)
│   ├── tools/             # 7 个 coding 工具 + 辅助
│   │   ├── read.ts write.ts edit.ts bash.ts grep.ts ls.ts find.ts
│   │   ├── edit-diff.ts        # edit 底层逻辑
│   │   └── output-accumulator.ts  # bash 的流式 + /tmp 兜底
│   ├── agent/             # vendored pi-agent-core(harness、session repo、compaction、env)
│   └── ai/                # vendored pi-ai(openai-completions、compat 流式、trace)
├── viewer.html            # trace viewer UI
├── scripts/               # 运行时测试(工具、workspace)
└── PI_CODING_AGENT_CONTEXT_DESIGN.md   # 上下文管理设计笔记
```

### 脚本

| 命令 | 作用 |
|------|------|
| `npm start` | 跑 agent REPL。 |
| `npm run view` | 起 trace viewer。 |
| `npm run typecheck` | `tsc --noEmit`。 |
| `npm run test:tools` | 7 个工具的运行时测试。 |
| `npm run test:workspace` | workspace 解析 + 状态隔离测试。 |

### 工作原理

sgagent 通过三层防线防止长跑的 agent loop 撑爆上下文(借鉴自 Pi;分析见 [`PI_CODING_AGENT_CONTEXT_DESIGN.md`](./PI_CODING_AGENT_CONTEXT_DESIGN.md)):

1. **逐工具输出截断** —— *默认开启*。`read` 上限 2000 行 / 50KB 并支持 `offset`/`limit` 分页;`bash` 保留尾部。这就是阻止"单轮填满窗口"的关键。
2. **历史压缩(compaction)** —— vendored 的 core 能把早期对话摘要成结构化总结以腾出空间。(core 里已具备;**本 CLI 暂未启用**。)
3. **触发策略** —— 何时截断 / 何时压缩 / 何时不动。

### 致谢

agent-core 与 AI 层 vendored 自 [`earendil-works/pi`](https://github.com/earendil-works/pi)(MIT,© 2025 Mario Zechner)。7 个 coding 工具改编自 pi-coding-agent。

### License

[MIT](./LICENSE) © 2026 yangjie-ai
