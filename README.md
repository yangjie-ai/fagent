<div align="center">

# sgagent

**A minimal, self-contained coding agent CLI.**  
OpenAI-compatible · streaming · default MiMo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.12.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)

**English** · **[中文](./README.zh-CN.md)**

</div>

---

> The repository is hosted as [`yangjie-ai/fagent`](https://github.com/yangjie-ai/fagent); the CLI / package name is **sgagent**.

## What is sgagent?

sgagent is a tiny terminal coding agent. It can read, write, and edit files, run shell commands, and search a codebase — driven by any OpenAI-compatible chat model (it ships configured for [MiMo](https://www.xiaomimimo.com/) out of the box).

It is **fully self-contained**: the [`pi-agent-core`](https://github.com/earendil-works/pi) (agent harness) and [`pi-ai`](https://github.com/earendil-works/pi) (model layer) source is **vendored** into [`src/agent`](./src/agent) and [`src/ai`](./src/ai), aliased through `tsconfig` `paths` (`@earendil-works/*` → local source). There are **no external pi npm dependencies** — `git clone` + `npm install` and you're running.

sgagent was built to study and borrow from Pi's context-management design — specifically to fix the classic failure mode where *a single `read` blows up the whole context window*. The tool layer enforces per-call output truncation and paging (see [How it works](#how-it-works)).

## Features

- **7 coding tools with context discipline** — `read` truncates to 2000 lines / 50 KB (whichever hits first) and supports `offset`/`limit` paging; `bash` keeps the tail. One tool call can no longer fill the context.
- **Multi-project workspaces** — all state (sessions, traces) lives in `~/.fagent`, keyed per project. Switch projects with `--workspace`; the target project directory stays clean (no `.sessions/` or `data/` pollution).
- **Persistent sessions + resume** — every project's conversation history is persisted to JSONL; on start you can pick a past session and the text thread is replayed.
- **Model + tool traces + browser viewer** — every loop streams model and tool traces to disk; `npm run view` serves a local page to inspect them.
- **Streaming with reasoning** — live token streaming, including thinking/reasoning content for reasoning models.
- **Resilient calls** — automatic retry with a classifier + exponential backoff (covers 4xx/5xx).

## Requirements

- **Node.js ≥ 20.12.0** (uses `process.loadEnvFile(path)`).

## Quick start

```bash
git clone https://github.com/yangjie-ai/fagent.git
cd fagent
npm install
printf 'API_KEY=your-key\n' > .env
npm start
```

Then just type a question at the `> ` prompt. Type `exit` to quit.

## Configuration

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

## Usage

**REPL** — run `npm start`, type prompts at `> `, `exit` to quit. Token usage is printed after each turn.

**Choosing a workspace** (the project sgagent operates on):

- `npm start` — bare start. If any workspace is known, a **picker** lists them (most-recently-used first); pick one, or `0` for the current directory. With no known workspace, it just uses the current directory.
- `npm start -- --workspace <abs-path>` — switch to a specific project (use **forward slashes**; a *quoted* Windows backslash path is auto-converted `\` → `/`).
- `npm start -- --migrate --workspace <path>` — move an old in-project layout (`<proj>/.sessions`, `<proj>/data`) into `~/.fagent`, then exit.

**Resume** — on start, pick a past session from the history list; its text thread is replayed so you can continue the conversation.

**Viewer** — `npm run view`, then open the printed URL to inspect model/tool traces in the browser.

## Project structure

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

## Scripts

| Command | What it does |
|---------|--------------|
| `npm start` | Run the agent REPL. |
| `npm run view` | Serve the trace viewer. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test:tools` | Runtime tests for the 7 tools. |
| `npm run test:workspace` | Tests for workspace resolution + state isolation. |

## How it works

sgagent keeps a long-running agent loop from blowing its context through three layers (borrowed from Pi; analyzed in [`PI_CODING_AGENT_CONTEXT_DESIGN.md`](./PI_CODING_AGENT_CONTEXT_DESIGN.md)):

1. **Per-tool output truncation** — *enabled by default.* `read` is capped at 2000 lines / 50 KB with `offset`/`limit` paging; `bash` keeps the tail. This is what stops a single turn from filling the window.
2. **History compaction** — the vendored core can summarize old turns into a structured summary to free space. (Present in the core; **not yet wired into this CLI**.)
3. **Trigger strategy** — when to truncate vs. compact vs. do nothing.

## Acknowledgements

The agent-core and AI layers are vendored from [`earendil-works/pi`](https://github.com/earendil-works/pi) (MIT, © 2025 Mario Zechner). The 7 coding tools are adapted from pi-coding-agent.

## License

[MIT](./LICENSE) © 2026 yangjie-ai
