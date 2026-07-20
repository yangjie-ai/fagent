<div align="center">

# sgagent

**一个能从头读懂、能看见每一轮运行的极简 coding agent。**  
OpenAI 兼容 · 流式 · 默认 MiMo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.12.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6.svg)](https://www.typescriptlang.org/)

**[English](./README.md)** · **中文**

</div>

---

> 仓库地址是 [`yangjie-ai/fagent`](https://github.com/yangjie-ai/fagent);CLI / 包名是 **sgagent**。

## sgagent 是什么?

sgagent 是一个**为学习而生的极简 coding agent**。它的目标不是堆功能,而是让你**看懂一个 agent loop 到底怎么跑**——通过读一份小而完整的代码,再看真实运行轨迹。

它**改编自 [Pi](https://github.com/earendil-works/pi)**:把 Pi 的 agent core(`pi-agent-core`)和模型层(`pi-ai`)**vendored** 进 [`src/agent`](./src/agent) 和 [`src/ai`](./src/ai),把 Pi 的 coding 工具**改编合并成 7 个工具**放进 [`src/tools`](./src/tools)。最终得到一个极小、可读的 coding agent——没有框架魔法,一切都在仓库里(`git clone` + `npm install` 就能跑,没有任何外部 pi npm 依赖)。

**一条 prompt = 一轮 loop。** 你输入一条 prompt,agent 流式回复、调用工具、循环直到任务完成。这轮 loop 里每一次模型调用、每一次工具执行都会落盘,**[`viewer.html`](./viewer.html)** 把整个过程重放成一条分步时间线——它看到的输入、命中的缓存、它想了什么、选了哪些工具及为什么、每次调用的原始请求/响应。**这条时间线才是重点**:它把一个黑盒 agent 变成你能真正研究的东西。

> 一轮 loop 能学到什么:上下文怎么逐轮增长、缓存命中落在哪、一个工具调用是怎么决定并执行的,以及经典痛点*“一次 `read` 就把整个上下文窗口撑爆”*从哪来——工具层如何防御(见[工作原理](#工作原理))。

## 用 viewer.html 看运行轨迹

这就是学习用的放大镜。你发的每一条 prompt 都跑成**一轮 loop** 并落进一个 JSONL 文件;`viewer.html` 把它变成一条可读的时间线。

**启动** —— `npm run view`,打开打印的 URL(`http://localhost:<VIEW_PORT>`,默认 `4789`),会自动加载该工作区的全部 trace。也可以直接打开 [`viewer.html`](./viewer.html),选择 / 拖入 `data` 文件夹。

**你会看到** —— 侧边栏按天分组的 loop 列表;点开一个,是一个**用户输入气泡**(触发这轮 loop 的 prompt)、**5 个 token 磁贴**(实际输入 / 缓存命中 + 命中率% / 输出 / 思考 / 合计),以及一条**步骤时间线**。每个步骤是两种之一:

- 💬 **LLM 调用** —— 请求被拆成**新增 vs 命中的缓存前缀**,输出则是:思考块 🤔、文本回复 📝、以及它做出的**工具调用决策** 🔧。每行显示新增/缓存/输出 token 与命中率。展开 `请求/响应详情` 看**原始请求与响应 JSON**。
- 🔧 **工具执行** —— 工具名、参数、完整结果、字符数、耗时(ms),以及 ✓ 完成 / ✗ 出错 标记。

> 多读几轮 loop,你会具体地看到:上下文每轮怎么涨、缓存到底在哪省钱、一个工具调用是怎么被选中并执行的、一次糟糕的 `read` 是怎么被挡在窗口之外的。

trace 落在 `~/.fagent/workspaces/<bucket>/data/<YYYYMMDD>/<loopId>.jsonl`——**一轮 loop 一个文件**,两种记录类型(`model`、`tool`)。见 [`src/ai/utils/trace.ts`](./src/ai/utils/trace.ts)(`beginLoop` / `saveModelTrace` / `saveToolTrace`)。

## 特性

- **把 trace viewer 摆在 C 位** —— 每轮 loop 都记录每一次模型调用和工具执行;`npm run view` 把 [`viewer.html`](./viewer.html) 作为一条可读时间线提供,让你看清这轮 loop 到底怎么跑。见[用 viewer.html 看运行轨迹](#用-viewerhtml-看运行轨迹)。
- **7 个 coding 工具 + 上下文纪律** —— `read` 截断到 2000 行 / 50KB(先到为准),支持 `offset`/`limit` 分页;`bash` 保留尾部。单次工具调用不会再把上下文填满。
- **多项目工作区** —— 所有状态(会话、trace)集中在 `~/.fagent`,按项目分桶。用 `--workspace` 切换项目;目标项目目录保持干净(不污染 `.sessions/` 或 `data/`)。
- **会话持久化 + 续聊** —— 每个项目的对话历史落到 JSONL;启动可选历史会话,并回显文本主线。
- **流式输出 + 推理** —— 实时 token 流式,含推理模型的 thinking/reasoning 内容。
- **健壮调用** —— 自动重试 + 分类器 + 指数退避(覆盖 4xx/5xx)。

## 环境要求

- **Node.js ≥ 20.12.0**(用到 `process.loadEnvFile(path)`)。

## 快速开始

```bash
git clone https://github.com/yangjie-ai/fagent.git
cd fagent
npm install
cp .env.sample .env   # 然后编辑 .env,填入 API_KEY
npm start
```

然后在 `> ` 提示符后输入问题。输入 `exit` 退出。

## 配置

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

## 用法

**REPL** —— 跑 `npm start`,在 `> ` 后输入,`exit` 退出。每轮结束打印 token 用量。

**选择工作区**(sgagent 操作的项目):

- `npm start` —— 裸启动。若有已知工作区,会弹**选择器**(按最近使用排序);选一个,或 `0` 用当前目录。无已知工作区时直接用当前目录。
- `npm start -- --workspace <绝对路径>` —— 切到指定项目(用**正斜杠**;*加引号*的 Windows 反斜杠路径会自动 `\` → `/`)。
- `npm start -- --migrate --workspace <路径>` —— 把老的项目内布局(`<proj>/.sessions`、`<proj>/data`)搬进 `~/.fagent`,然后退出。

**续聊** —— 启动时从历史列表选一条,会回显其文本主线,接着聊。

**viewer** —— `npm run view`,然后打开打印的 URL。见[用 viewer.html 看运行轨迹](#用-viewerhtml-看运行轨迹)。

## 项目结构

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

## 脚本

| 命令 | 作用 |
|------|------|
| `npm start` | 跑 agent REPL。 |
| `npm run view` | 起 trace viewer。 |
| `npm run typecheck` | `tsc --noEmit`。 |
| `npm run test:tools` | 7 个工具的运行时测试。 |
| `npm run test:workspace` | workspace 解析 + 状态隔离测试。 |

## 工作原理

sgagent 通过三层防线防止长跑的 agent loop 撑爆上下文(借鉴自 Pi;分析见 [`PI_CODING_AGENT_CONTEXT_DESIGN.md`](./PI_CODING_AGENT_CONTEXT_DESIGN.md)):

1. **逐工具输出截断** —— *默认开启*。`read` 上限 2000 行 / 50KB 并支持 `offset`/`limit` 分页;`bash` 保留尾部。这就是阻止“单轮填满窗口”的关键。
2. **历史压缩(compaction)** —— vendored 的 core 能把早期对话摘要成结构化总结以腾出空间。(core 里已具备;**本 CLI 暂未启用**。)
3. **触发策略** —— 何时截断 / 何时压缩 / 何时不动。

## 致谢

agent-core 与 AI 层 vendored 自 [`earendil-works/pi`](https://github.com/earendil-works/pi)(MIT,© 2025 Mario Zechner)。7 个 coding 工具改编合并自 pi-coding-agent。

## License

[MIT](./LICENSE) © 2026 yangjie-ai
