# sgagent → Rust 迁移方案

## 一、项目现状分析

### 1.1 项目概览

**sgagent** 是一个基于 OpenAI 兼容协议的终端编码 Agent CLI，核心能力：
- 连接任意 OpenAI 兼容端点（MiMo、DeepSeek、vLLM、Ollama 等）
- 支持 reasoning 模型的 thinking 流式输出
- 提供 7 个文件/Shell 工具（read、write、edit、bash、grep、ls、find）
- Agent Loop 自动循环：LLM 调用 → 工具执行 → 结果回注 → 继续
- 会话持久化（JSONL 格式）+ 历史会话恢复
- Trace 可视化查看器（viewer.html + 简易 HTTP 服务）

### 1.2 代码量 & 模块分布

| 模块 | 行数 | 职责 |
|------|------|------|
| `src/agent/harness/agent-harness.ts` | 1029 | Agent 高层编排（session、tools、hooks、compaction） |
| `src/agent/agent-loop.ts` | 846 | Agent Loop 核心循环（流式响应、工具执行、重试） |
| `src/agent/harness/types.ts` | 838 | 类型定义（Agent/Tool/Session 全部接口） |
| `src/agent/harness/compaction/compaction.ts` | 753 | 上下文压缩（摘要生成、裁剪） |
| `src/agent/agent.ts` | 575 | Agent 状态机（消息队列、事件分发） |
| `src/agent/harness/env/nodejs.ts` | 569 | Node.js 执行环境（FS/Shell 抽象） |
| `src/ai/api/openai-completions.ts` | 518 | OpenAI 兼容流式客户端（SSE 解析） |
| `src/agent/harness/skills.ts` | 375 | Skill 系统 |
| `src/agent/proxy.ts` | 367 | Proxy 流转发 |
| `src/agent/harness/utils/truncate.ts` | 344 | 输出截断 |
| `src/agent/harness/session/session.ts` | 338 | Session 抽象层 |
| `src/agent/harness/session/jsonl-storage.ts` | 314 | JSONL 持久化存储 |
| 其余 30+ 文件 | ~4800 | 工具实现、工具函数、类型等 |
| **总计** | **~11161** | |

### 1.3 依赖关系图

```
main.ts
  ├── tools/index.ts → [read, write, edit, bash, grep, ls, find].ts
  ├── agent/index.ts (pi-agent-core)
  │   ├── agent.ts (Agent 状态机)
  │   │   └── agent-loop.ts (核心循环)
  │   │       └── ai/compat.ts → ai/api/openai-completions.ts
  │   ├── harness/agent-harness.ts (高层编排)
  │   │   ├── harness/session/ (JSONL 持久化)
  │   │   ├── harness/compaction/ (上下文压缩)
  │   │   └── harness/env/nodejs.ts (FS/Shell)
  │   └── proxy.ts
  └── ai/utils/trace.ts (trace 写入)
view.ts (独立 HTTP 查看器)
```

### 1.4 关键技术特征

1. **流式处理**：基于 `EventStream<T, R>` 自实现的 async iterator，LLM 响应是 SSE 流式
2. **Schema 验证**：使用 TypeBox (JSON Schema) 定义工具参数，运行时校验
3. **事件驱动**：Agent 通过 subscribe/on 模式分发 20+ 种事件类型
4. **JSONL 持久化**：会话 + trace 都是 append-only JSONL
5. **跨平台 Shell**：NodeExecutionEnv 封装了 bash/sh 的查找和进程树管理
6. **OpenAI SDK 依赖**：`openai` npm 包处理 SSE 解析和类型转换

---

## 二、为什么用 Rust 重写

| 维度 | TypeScript/Node.js | Rust |
|------|-------------------|------|
| **启动速度** | ~200ms（V8 启动 + tsx 编译） | <5ms（原生二进制） |
| **内存占用** | ~50-80MB（V8 堆） | ~5-10MB |
| **并发模型** | 单线程事件循环 | 原生 async + 多线程 |
| **流式处理** | async iterator（GC 压力） | 零拷贝 stream（无 GC） |
| **二进制分发** | 需要 Node.js 运行时 | 单文件静态链接 |
| **错误处理** | 运行时异常 | 编译期保证 |
| **SSE 解析** | 依赖 openai SDK | 自实现，更轻量 |
| **Shell 执行** | child_process + 复杂的进程树管理 | tokio::process + nix 信号 |
| **Schema 验证** | TypeBox 运行时 JSON Schema | schemars + serde 编译期+运行时 |

---

## 三、Rust 项目结构设计

```
sgagent/
├── Cargo.toml
├── Cargo.lock
├── .env.example
├── viewer.html              # 保留不变
│
├── crates/
│   ├── sgagent-core/        # 核心 Agent 框架（pi-agent-core 对应）
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs           # Agent/Tool/Session 类型定义
│   │       ├── agent.rs           # Agent 状态机
│   │       ├── loop.rs            # Agent Loop 核心循环
│   │       ├── event.rs           # 事件系统
│   │       ├── tool.rs            # Tool trait + 执行逻辑
│   │       ├── session/
│   │       │   ├── mod.rs
│   │       │   ├── memory.rs      # 内存 Session
│   │       │   └── jsonl.rs       # JSONL 持久化
│   │       ├── harness/
│   │       │   ├── mod.rs
│   │       │   ├── agent_harness.rs  # 高层编排
│   │       │   └── compaction.rs     # 上下文压缩
│   │       └── env/
│   │           ├── mod.rs         # ExecutionEnv trait
│   │           └── local.rs       # 本地 FS/Shell 实现
│   │
│   ├── sgagent-ai/         # AI 模型层（pi-ai 对应）
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs           # Model/Context/Message 类型
│   │       ├── openai.rs          # OpenAI 兼容流式客户端
│   │       ├── stream.rs          # EventStream 实现
│   │       ├── transform.rs       # 消息转换
│   │       ├── cost.rs            # 费用计算
│   │       ├── json_parse.rs      # 流式 JSON 解析
│   │       └── trace.rs           # Trace 写入
│   │
│   └── sgagent-cli/        # CLI 入口
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs            # CLI 主循环
│           ├── view.rs            # HTTP 查看器
│           └── tools/
│               ├── mod.rs
│               ├── read.rs
│               ├── write.rs
│               ├── edit.rs
│               ├── bash.rs
│               ├── grep.rs
│               ├── ls.rs
│               └── find.rs
│
└── tests/
    ├── integration/
    └── fixtures/
```

---

## 四、核心 Crate 设计

### 4.1 `sgagent-ai` — AI 模型层

#### 关键类型

```rust
// types.rs
use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: Api,
    pub provider: String,
    pub base_url: String,
    pub reasoning: bool,
    pub input: Vec<InputModality>,
    pub cost: ModelCost,
    pub context_window: u64,
    pub max_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Api {
    #[serde(rename = "openai-completions")]
    OpenAICompletions,
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Context {
    pub system_prompt: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Option<Vec<ToolDef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
pub enum Message {
    #[serde(rename = "user")]
    User { content: UserContent, timestamp: i64 },
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),
    #[serde(rename = "toolResult")]
    ToolResult(ToolResultMessage),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub content: Vec<ContentBlock>,
    pub api: String,
    pub provider: String,
    pub model: String,
    pub usage: Usage,
    pub stop_reason: StopReason,
    pub error_message: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String, thinking_signature: Option<String> },
    #[serde(rename = "toolCall")]
    ToolCall { id: String, name: String, arguments: serde_json::Value },
    #[serde(rename = "image")]
    Image { data: String, mime_type: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum StopReason {
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "length")]
    Length,
    #[serde(rename = "toolUse")]
    ToolUse,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "aborted")]
    Aborted,
}
```

#### 流式客户端

```rust
// openai.rs — 核心流式请求
use reqwest::Client;
use futures::stream::{Stream, StreamExt};
use tokio::sync::mpsc;

pub struct OpenAICompletionsClient {
    client: Client,
}

impl OpenAICompletionsClient {
    pub fn new() -> Self {
        Self { client: Client::new() }
    }

    /// 流式请求，返回 SSE 事件流
    pub async fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
    ) -> Result<Pin<Box<dyn Stream<Item = AssistantMessageEvent> + Send>>> {
        let request = self.build_request(model, context, &options)?;
        let response = self.client
            .post(format!("{}/chat/completions", model.base_url))
            .header("Authorization", format!("Bearer {}", options.api_key.as_deref().unwrap_or("")))
            .header("Content-Type", "application/json")
            .json(&request)
            .send()
            .await?;

        // SSE 解析 → 事件流
        let stream = Self::parse_sse_stream(response).await?;
        Ok(stream.boxed())
    }

    fn build_request(&self, model: &Model, context: &Context, options: &StreamOptions) -> serde_json::Value {
        // 构造 OpenAI Chat Completions 请求体
        // 与当前 openai-completions.ts 逻辑一致
        todo!()
    }
}
```

#### EventStream — Rust 版

```rust
// stream.rs
use tokio::sync::mpsc;
use futures::stream::Stream;

pub struct EventStream<T> {
    rx: mpsc::UnboundedReceiver<T>,
}

impl<T> EventStream<T> {
    pub fn new() -> (EventStreamSender<T>, Self) {
        let (tx, rx) = mpsc::unbounded_channel();
        (EventStreamSender { tx }, Self { rx })
    }
}

impl<T> Stream for EventStream<T> {
    type Item = T;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

pub struct EventStreamSender<T> {
    tx: mpsc::UnboundedSender<T>,
}

impl<T> EventStreamSender<T> {
    pub fn push(&self, event: T) {
        let _ = self.tx.send(event);
    }
}
```

### 4.2 `sgagent-core` — Agent 框架层

#### Tool Trait

```rust
// tool.rs
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 工具执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub content: Vec<ContentBlock>,
    pub details: serde_json::Value,
    pub terminate: Option<bool>,
}

/// 工具 trait — 所有工具必须实现
#[async_trait]
pub trait AgentTool: Send + Sync {
    fn name(&self) -> &str;
    fn label(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_json_schema(&self) -> serde_json::Value;

    async fn execute(
        &self,
        tool_call_id: &str,
        params: serde_json::Value,
        signal: Option<CancellationToken>,
    ) -> Result<ToolResult, ToolError>;

    /// 参数预处理（可选）
    fn prepare_arguments(&self, args: serde_json::Value) -> serde_json::Value {
        args
    }
}
```

#### Agent Loop

```rust
// loop.rs
pub async fn run_agent_loop(
    prompts: Vec<AgentMessage>,
    context: AgentContext,
    config: AgentLoopConfig,
    emitter: impl AgentEventEmitter,
    signal: Option<CancellationToken>,
    stream_fn: impl StreamFn,
) -> Result<Vec<AgentMessage>> {
    let mut current_context = context;
    let mut new_messages = prompts.clone();
    let mut retry_attempts = 0;

    emitter.emit(AgentEvent::AgentStart).await?;

    // 外层循环：follow-up 消息
    loop {
        let mut has_more_tool_calls = true;

        // 内层循环：工具调用 + steering
        while has_more_tool_calls {
            // 1. 流式获取 assistant 响应
            let message = stream_assistant_response(
                &mut current_context, &config, signal.as_ref(), &emitter, &stream_fn
            ).await?;

            new_messages.push(message.clone());

            // 2. 错误/中止处理 + 重试
            if matches!(message.stop_reason, StopReason::Error | StopReason::Aborted) {
                if should_retry(&message, retry_attempts) {
                    retry_attempts += 1;
                    // backoff + retry
                    continue;
                }
                // 不可重试，终止
                emitter.emit(AgentEvent::AgentEnd { messages: new_messages }).await?;
                return Ok(new_messages);
            }
            retry_attempts = 0;

            // 3. 执行工具调用
            let tool_calls: Vec<_> = message.content.iter()
                .filter_map(|b| match b { ContentBlock::ToolCall { .. } => Some(b), _ => None })
                .collect();

            if !tool_calls.is_empty() {
                let results = execute_tool_calls(
                    &current_context, &message, &config, signal.as_ref(), &emitter
                ).await?;
                // 将工具结果注入上下文
                for result in &results {
                    current_context.messages.push(result.clone().into());
                    new_messages.push(result.clone().into());
                }
                has_more_tool_calls = !results.iter().all(|r| r.terminate == Some(true));
            } else {
                has_more_tool_calls = false;
            }

            // 4. 检查 steering 队列
            // 5. 检查 should_stop_after_turn
        }

        // 6. 检查 follow-up 队列
        let follow_ups = config.get_follow_up_messages().await?;
        if follow_ups.is_empty() { break; }
    }

    emitter.emit(AgentEvent::AgentEnd { messages: new_messages }).await?;
    Ok(new_messages)
}
```

#### 事件系统

```rust
// event.rs
use async_trait::async_trait;

#[derive(Debug, Clone)]
pub enum AgentEvent {
    AgentStart,
    AgentEnd { messages: Vec<AgentMessage> },
    TurnStart,
    TurnEnd { message: AgentMessage, tool_results: Vec<ToolResultMessage> },
    MessageStart { message: AgentMessage },
    MessageUpdate { message: AgentMessage },
    MessageEnd { message: AgentMessage },
    ToolExecutionStart { tool_call_id: String, tool_name: String, args: serde_json::Value },
    ToolExecutionEnd { tool_call_id: String, tool_name: String, result: ToolResult, is_error: bool },
}

#[async_trait]
pub trait AgentEventEmitter: Send + Sync {
    async fn emit(&self, event: AgentEvent) -> Result<()>;
}
```

### 4.3 `sgagent-cli` — CLI 工具层

#### 工具实现（以 bash 为例）

```rust
// tools/bash.rs
use async_trait::async_trait;
use sgagent_core::{AgentTool, ToolResult, ToolError, ContentBlock};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BashParams {
    /// The shell command to execute
    pub command: String,
}

pub struct BashTool {
    timeout_secs: u64,
}

#[async_trait]
impl AgentTool for BashTool {
    fn name(&self) -> &str { "bash" }
    fn label(&self) -> &str { "Bash" }
    fn description(&self) -> &str { "Execute a shell command and return combined stdout+stderr." }
    fn parameters_json_schema(&self) -> serde_json::Value {
        schemars::schema_for!(BashParams).into()
    }

    async fn execute(
        &self,
        _tool_call_id: &str,
        params: serde_json::Value,
        signal: Option<CancellationToken>,
    ) -> Result<ToolResult, ToolError> {
        let params: BashParams = serde_json::from_value(params)
            .map_err(|e| ToolError::InvalidParams(e.to_string()))?;

        let output = tokio::time::timeout(
            std::time::Duration::from_secs(self.timeout_secs),
            Command::new("bash")
                .arg("-c")
                .arg(&params.command)
                .output()
        ).await;

        match output {
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                let combined = format!("{stdout}{stderr}");
                Ok(ToolResult {
                    content: vec![ContentBlock::Text {
                        text: if combined.is_empty() { "(no output)".into() } else { combined },
                    }],
                    details: serde_json::json!({
                        "command": params.command,
                        "exitCode": out.status.code().unwrap_or(-1)
                    }),
                    terminate: None,
                })
            }
            Ok(Err(e)) => Err(ToolError::ExecutionFailed(e.to_string())),
            Err(_) => Err(ToolError::ExecutionFailed("Timeout".into())),
        }
    }
}
```

#### CLI 主循环

```rust
// main.rs
use std::io::{self, BufRead, Write};
use sgagent_core::{AgentHarness, AgentEvent};
use sgagent_ai::OpenAICompletionsClient;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. 加载 .env
    dotenvy::dotenv().ok();

    let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "https://api.xiaomimimo.com/v1".into());
    let model_id = std::env::var("MODEL_ID").unwrap_or_else(|_| "mimo-v2.5".into());
    let api_key = std::env::var("API_KEY").expect("API_KEY is required");

    // 2. 构建模型 & 工具
    let model = Model::from_env();
    let tools: Vec<Box<dyn AgentTool>> = vec![
        Box::new(ReadTool::new()),
        Box::new(WriteTool::new()),
        Box::new(EditTool::new()),
        Box::new(BashTool::new(30)),
        Box::new(GrepTool::new()),
        Box::new(LsTool::new()),
        Box::new(FindTool::new()),
    ];

    // 3. 构建 Harness
    let harness = AgentHarness::new(/* ... */);

    // 4. 交互循环
    println!("sgagent — OpenAI-compatible coding agent ({model_id} @ {base_url})");
    println!("Type 'exit' to quit.\n");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let input = line?;
        let trimmed = input.trim();
        if trimmed.is_empty() { continue; }
        if trimmed == "exit" || trimmed == "quit" { break; }

        // 5. 发起 prompt
        let mut stream = harness.prompt(trimmed).await?;
        while let Some(event) = stream.next().await {
            match event {
                AgentEvent::MessageUpdate { message } => {
                    // 增量打印文本/thinking
                    print_delta(&message);
                }
                AgentEvent::ToolExecutionStart { tool_name, args, .. } => {
                    eprintln!("\n  [{tool_name}] {}", truncate(&args.to_string(), 200));
                }
                AgentEvent::MessageEnd { message } => {
                    // 打印 usage
                    let u = &message.usage;
                    eprintln!("\n  [usage] in {} · cache {} · out {}",
                        fmt_tokens(u.input + u.cache_read),
                        fmt_tokens(u.cache_read),
                        fmt_tokens(u.output)
                    );
                }
                _ => {}
            }
            io::stdout().flush()?;
        }
        println!();
    }

    Ok(())
}
```

#### HTTP 查看器

```rust
// view.rs — 用 axum 替代 Node http
use axum::{Router, extract::State, response::Json, routing::get};
use tokio::fs;

async fn api_traces() -> Json<Vec<TraceFile>> {
    let files = walk_jsonl("data").await.unwrap_or_default();
    Json(files)
}

async fn viewer_html() -> impl IntoResponse {
    let html = include_str!("../../viewer.html");
    ([("content-type", "text/html; charset=utf-8")], html)
}

pub async fn serve(port: u16) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/api/traces", get(api_traces))
        .route("/", get(viewer_html))
        .route("/viewer.html", get(viewer_html));

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    println!("viewer → http://localhost:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
```

---

## 五、关键依赖选型

| 领域 | Crate | 理由 |
|------|-------|------|
| **异步运行时** | `tokio` (full) | 生态标准，process/FS/net 全覆盖 |
| **HTTP 客户端** | `reqwest` | 流式 SSE 支持，与 tokio 集成好 |
| **HTTP 服务端** | `axum` | 轻量、类型安全、tokio 原生 |
| **SSE 解析** | `eventsource-stream` + 手写 | OpenAI SSE 格式简单，半自写更可控 |
| **JSON Schema** | `schemars` + `serde_json` | 编译期从 struct 生成 schema |
| **参数验证** | `serde` (deserialize) + `jsonschema` | serde 反序列化自带校验，jsonschema 做兜底 |
| **流式 JSON** | `partial-json` 或自写 | 对应 partial-json npm 包 |
| **.env 加载** | `dotenvy` | 成熟、无额外依赖 |
| **CLI 交互** | `rustyline` | readline 封装，支持历史/补全 |
| **进程管理** | `tokio::process` + `nix` | 异步子进程 + Unix 信号 |
| **错误处理** | `anyhow` (app) + `thiserror` (lib) | 分层错误策略 |
| **UUID** | `uuid` (v7) | 对应 uuidv7 |
| **YAML** | `serde_yaml` | skill/template 配置（如需） |
| **正则** | `regex` | grep 工具 |
| **glob** | `glob` | find 工具 |
| **忽略文件** | `ignore` (ripgrep 同款) | 对应 ignore npm 包 |

### 关键 Cargo.toml 片段

```toml
# crates/sgagent-ai/Cargo.toml
[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["stream", "json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = "0.8"
futures = "0.3"
thiserror = "1"
tracing = "0.1"

# crates/sgagent-core/Cargo.toml
[dependencies]
sgagent-ai = { path = "../sgagent-ai" }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
async-trait = "0.1"
schemars = "0.8"
uuid = { version = "1", features = ["v7"] }
thiserror = "1"
tracing = "0.1"

# crates/sgagent-cli/Cargo.toml
[dependencies]
sgagent-core = { path = "../sgagent-core" }
sgagent-ai = { path = "../sgagent-ai" }
tokio = { version = "1", features = ["full"] }
anyhow = "1"
dotenvy = "0.15"
rustyline = "14"
axum = "0.7"
reqwest = { version = "0.12", features = ["stream", "json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
glob = "0.3"
regex = "1"
ignore = "0.4"
```

---

## 六、迁移策略 & 分期计划

### Phase 0：项目脚手架（1-2 天）

- [ ] 初始化 workspace，创建 3 个 crate
- [ ] 搭建 CI（cargo fmt/clippy/test）
- [ ] 定义核心类型（`types.rs`），确保 serde 序列化与 TS 版 JSON 格式兼容
- [ ] 编写类型兼容性测试：TS 版写入的 JSONL 能被 Rust 版反序列化

### Phase 1：`sgagent-ai` — AI 模型层（3-5 天）

按优先级：

1. **类型定义** (`types.rs`)
   - `Model`, `Context`, `Message`, `ContentBlock`, `Usage`, `StopReason`
   - 全部 derive `Serialize`/`Deserialize`，确保 JSON 兼容

2. **EventStream** (`stream.rs`)
   - 基于 `tokio::sync::mpsc` 实现
   - 实现 `futures::Stream` trait

3. **OpenAI 兼容客户端** (`openai.rs`)
   - SSE 流式请求：reqwest + 手写 SSE 行解析
   - 增量 JSON 解析（tool call arguments）
   - thinking/reasoning_content 支持
   - usage 解析（含 cache_tokens）
   - 错误处理 + 重试

4. **消息转换** (`transform.rs`)
   - 移植 `transform-messages.ts` 逻辑
   - 处理跨模型 thinking block、orphan tool calls

5. **Trace 写入** (`trace.rs`)
   - JSONL append-only 写入
   - 与 TS 版格式兼容

6. **测试**
   - 单元测试：SSE 解析、消息转换、usage 计算
   - 集成测试：mock SSE server → 端到端流式验证

### Phase 2：`sgagent-core` — Agent 框架层（5-7 天）

1. **Tool trait** (`tool.rs`)
   - `AgentTool` trait + 参数校验
   - JSON Schema 生成

2. **Agent Loop** (`loop.rs`)
   - 核心循环：stream → execute → inject → repeat
   - Sequential / Parallel 工具执行
   - 重试 + 指数退避
   - Steering / Follow-up 消息队列

3. **Agent 状态机** (`agent.rs`)
   - 事件分发
   - 消息管理
   - abort 支持

4. **Session 持久化** (`session/`)
   - JSONL 格式读写（与 TS 版兼容）
   - Session 元数据管理
   - Memory session 用于测试

5. **AgentHarness** (`harness/`)
   - 高层编排
   - Hook 系统（before/after tool call, context transform 等）
   - Compaction（简化版，首版可跳过）

6. **ExecutionEnv** (`env/`)
   - trait 定义
   - 本地实现（FS + Shell）

7. **测试**
   - Mock stream fn → 端到端 agent loop 测试
   - Session 持久化往返测试

### Phase 3：`sgagent-cli` — CLI + 工具（3-5 天）

1. **7 个工具实现**
   - `read` → `tokio::fs::read_to_string` + 行截断
   - `write` → `tokio::fs::write` + 递归 mkdir
   - `edit` → 读取 → 替换 → 写入（唯一匹配逻辑）
   - `bash` → `tokio::process::Command`
   - `grep` → `ignore` crate 遍历 + `regex` 匹配
   - `ls` → `tokio::fs::read_dir`
   - `find` → `glob` crate 或 `ignore` crate

2. **CLI 主循环** (`main.rs`)
   - .env 加载
   - 会话选择 / 恢复
   - 增量输出打印
   - Usage 统计
   - Ctrl+C 中止

3. **HTTP 查看器** (`view.rs`)
   - axum 服务
   - `viewer.html` 内嵌或文件读取
   - `/api/traces` JSON 接口

4. **测试**
   - 工具单元测试
   - 端到端 CLI 测试（mock API）

### Phase 4：打磨 & 优化（2-3 天）

- [ ] 错误信息完善 + 用户友好提示
- [ ] 流式输出优化（减少锁竞争）
- [ ] 二进制 release 构建（cross-compilation）
- [ ] Shell 补全（clap completions）
- [ ] 性能基准测试（对比 TS 版启动时间 + 内存占用）
- [ ] 文档（README + 用法）

---

## 七、风险 & 对策

| 风险 | 影响 | 对策 |
|------|------|------|
| **SSE 解析兼容性** | 不同 OpenAI 兼容后端 SSE 格式微差 | 抽象 SSE parser 接口，参考 openai-node 实现 |
| **JSONL 格式兼容** | Rust 版需要读取 TS 版写入的历史会话 | 编写兼容性测试，serde 反序列化容错 |
| **流式 JSON 解析** | tool call arguments 增量解析复杂 | 移植 `partial-json` 逻辑，或用 `serde_json::Value` 手动合并 |
| **跨平台 Shell** | Windows bash 查找 + 进程树管理 | 首版支持 Linux/macOS，Windows 用 git-bash |
| **Compaction 功能** | 摘要生成逻辑复杂 | 首版跳过，后续迭代添加 |
| **Proxy 模式** | WebSocket 流转发 | 首版跳过，保留接口 |
| **TypeBox → schemars** | schema 生成可能不完全兼容 | 编写 schema 对比测试 |

---

## 八、预期收益

| 指标 | TS 版（估算） | Rust 版（预期） | 提升 |
|------|-------------|---------------|------|
| 冷启动 | ~200ms | <5ms | **40x** |
| 内存占用 | ~50-80MB | ~5-10MB | **8x** |
| 二进制大小 | N/A（需 Node.js） | ~8-15MB | 单文件分发 |
| 流式首 token 延迟 | ~50ms（V8 GC 间歇） | ~20ms | 2x |
| 工具执行开销 | ~5ms（child_process） | ~1ms（tokio spawn） | 5x |
| 并发工具执行 | 受事件循环限制 | 真并行 | 显著 |

---

## 九、总结

这是一个 **~11k 行 TypeScript** 项目，核心是 **Agent Loop + 流式 LLM 客户端 + 工具执行** 三大模块。Rust 重写的核心价值在于：

1. **单二进制分发**：无需 Node.js，`curl | tar` 即可运行
2. **低延迟启动**：对 Agent 这种频繁启动/交互的工具至关重要
3. **内存效率**：长会话、大上下文时优势明显
4. **类型安全**：编译期消除整类运行时错误
5. **真正的并发**：工具并行执行不再受事件循环限制

建议按 **4 个 Phase**、**总计 2-3 周** 完成，首版跳过 compaction 和 proxy，优先保证核心 Agent Loop 可用。
