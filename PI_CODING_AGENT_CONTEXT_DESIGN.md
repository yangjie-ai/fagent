# Pi Coding Agent 上下文管理设计分析

> 分析对象: [earendil-works/pi](https://github.com/earendil-works/pi) (本地克隆于 `../pi`)
> 起因: 用 agent coding 时"上下文一会就满了",研究 Pi 如何解决该问题,为 fagent 借鉴。
> 分析日期: 2026-07-16

---

## 0. 核心思路:三道防线

Pi 不是靠一招,而是**三个层面递进**地控制上下文体积:

| 防线 | 机制 | 解决什么 | 在哪 |
|---|---|---|---|
| **① 入口截断** | 每个工具自己限输出 | 大文件/长日志**不进**上下文 | `tools/truncate.ts` + 各工具 |
| **② 历史压缩** | compaction 摘要旧消息 | 已经进来的历史**变短** | `compaction/compaction.ts` |
| **③ 触发兜底** | 阈值主动 + 溢出被动 | 上面两道的**时机控制** | `agent-session.ts` |

## 1. 关键认知:三层架构,compaction 不在主循环里

去 `agent-loop.ts` 找压缩逻辑——**找不到**。Pi 故意分层:

| 层 | 文件 | 是否懂 compaction/token |
|---|---|---|
| L1 纯主循环 | `packages/agent/src/agent-loop.ts` | **不懂**,只暴露钩子 |
| L2 有状态 harness | `packages/agent/src/harness/agent-harness.ts` | 有 `compact()` 但**手动显式**,不自动触发 |
| L3 应用编排 | `packages/coding-agent/src/core/agent-session.ts` | **真正的自动 compaction 在这里** |

主循环每轮结束调 `prepareNextTurn` → `session.buildContext()` 重新拉消息。压缩结果**写进 session 树**,下一轮 buildContext 自然读到短版本——主循环对压缩**完全无感**。这是个干净的解耦。

### 主循环结构(`agent-loop.ts:155` `runLoop`)

双层 `while(true)`,**没有 maxTurns**:

```
runLoop():
  while true:                                   # 外层:follow-up 循环
    hasMoreToolCalls = true
    while hasMoreToolCalls or pendingSteering:   # 内层:工具/steering 循环
      emit turn_start
      message = streamAssistantResponse(context, config)   # ← 每轮 LLM 调用
      if stopReason in (error, aborted): 终止
      toolCalls = message.content.filter(toolCall)
      if toolCalls:
          batch = executeToolCalls(...)          # 并行或顺序,按 tool.executionMode
          context.messages.push(...toolResults)
          hasMoreToolCalls = !batch.terminate
      emit turn_end
      snapshot = config.prepareNextTurn?.(...)   # ← harness 在这里刷新整份 context
      config.shouldStopAfterTurn?.(...)          # ← 唯一的停止钩子
      pendingSteering = config.getSteeringMessages()
    followUp = config.getFollowUpMessages()
    if followUp: pendingSteering = followUp; continue
    break
  emit agent_end
```

**停止条件(无硬性轮数上限)**:`stopReason=error/aborted`、`shouldStopAfterTurn` 返回 true、工具结果全部 `terminate=true`、或无工具调用且两个队列都空。

### 每轮 LLM 调用前的上下文准备(`agent-loop.ts:281`,很薄)

1. `config.transformContext(messages)` — harness 里**只是触发一个 `context` hook,默认啥也不改**。
2. `config.convertToLlm(messages)` — 把 `AgentMessage[]` 转 provider `Message[]`(过滤掉 custom 等非 LLM 角色)。

**真正"重建上下文"的动作发生在每轮结束后的 `prepareNextTurn`**(`agent-harness.ts:435`):调 `createTurnState()` → 从 `session.buildContext()` 重新拉取消息 + 重算 systemPrompt/model/tools,整个 `context` 被替换。这是 compaction 能"自然生效"的关键。

---

## 2. 核心数字(写死的默认值)

```ts
// packages/agent/src/harness/compaction/compaction.ts:111
// (coding-agent 层 settings-manager.ts:774 同值)
DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
```

| 常量 | 值 | 含义 |
|---|---|---|
| `reserveTokens` | **16384** | 触发线 = `contextWindow - 16384`;200k 窗口 ≈ **92%** 才压 |
| `keepRecentTokens` | **20000** | 压缩后保留的近期 token 预算(其余全摘要) |
| `ESTIMATED_IMAGE_CHARS` | 4800 | 图片 token 估算 |
| `CHARS_PER_TOKEN` | 4 | 无 usage 时的退化解码(char/4) |
| `TOOL_RESULT_MAX_CHARS` | 2000 | 压缩时 tool result 序列化前的截断 |
| read/bash 输出上限 | 2000 行 / 50KB | `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES` |
| grep 单行上限 | 500 字符 | `GREP_MAX_LINE_LENGTH` |
| grep 匹配上限 | 100 | |
| bash 滚动窗口 | 100KB | `maxRollingBytes = maxBytes * 2` |
| bash 流式更新节流 | 100ms | `BASH_UPDATE_THROTTLE_MS` |

---

## 3. 防线 ①:工具输出截断(per-tool 入口控制)

### 截断策略:双限制,先到先截

**核心机制不是"头尾保留中间省略",而是二选一:保留头部 或 保留尾部。**

- **`truncateHead()`**(`coding-agent/tools/truncate.ts:78`): 从头保留 N 行/字节。**永不返回半行**(除非首行就超 50KB,返回空 + `firstLineExceedsLimit=true`)。适用 **read**——文件开头最重要。
- **`truncateTail()`**(`:168`): 从尾保留,从后往前累积。适用 **bash**——错误和最终结果在末尾。

harness 版(344 行)与 coding-agent 版(276 行)**算法完全相同**,仅环境适配差异:harness 版自带手写 `utf8ByteLength()`(不依赖 Node `Buffer`,为浏览器/Deno);coding-agent 版直接用 `Buffer.byteLength`。

### read 工具读大文件(`read.ts`)

- 用 `truncateHead()`——保留**开头**(`read.ts:288`)
- 参数级手动分页:schema 支持 `offset`(1-indexed 起始行)和 `limit`(`read.ts:20-24`)
- **无自动分页**,但截断时生成可操作的续读提示:
  ```
  [Showing lines 1-2000 of 5000. Use offset=2001 to continue.]
  ```
- 首行超限的 bash 降级提示(`read.ts:292-294`):`sed -n '${line}p' path | head -c 51200`
- 默认上限:不指定 limit 时,最多 2000 行 或 50KB

### bash 工具长输出(`bash.ts` + `output-accumulator.ts`)

- 用 `OutputAccumulator` → `truncateTail()`——保留**末尾**
- **流式累积**:stdout/stderr 每个 `data` chunk 喂给 `output.append()`(`bash.ts:359`)
- **完整输出落盘**:截断时写 `/tmp/pi-bash-*.log`,路径返回给模型(`bash.ts:370`)
- 进程**不被提前中止**,只是内存只留尾部窗口,全量在磁盘
- 截断提示:
  ```
  [Showing lines 1500-2000 of 5000. Full output: /tmp/pi-bash-xxxx.log]
  ```

### OutputAccumulator(`output-accumulator.ts`)解决的问题

**流式输出的内存有界累积 + 全量保存**。不是提前中止。

- **流式 UTF-8 解码**:`TextDecoder` + `{ stream: true }`,处理跨 chunk 的多字节字符边界
- **滚动尾部窗口**:`maxRollingBytes = maxBytes * 2` = 100KB;超出时 `trimTail()` 只留尾部,避免 OOM
- **临时文件兜底**:超限或超行时开 `/tmp/{prefix}-{hex}.log` 写入完整原始输出(prefix 由 bash 工具传 `"pi-bash"`)

### 各工具截断对照

| 机制 | 位置 | 策略 | 阈值 |
|---|---|---|---|
| read 截断 | `read.ts` | `truncateHead` 保头 + 手动 offset 续读 | 2000 行 / 50KB |
| bash 截断 | `bash.ts` | `OutputAccumulator` → `truncateTail` 保尾 + 全量落 `/tmp` | 2000 行 / 50KB,滚动窗口 100KB |
| grep 截断 | `grep.ts` | `truncateLine` 截单行 + `truncateHead` 截总量 | 单行 500 字符 / 100 匹配 / 50KB |
| find/ls 截断 | `find.ts`/`ls.ts` | `truncateHead`(纯字节限) | find 1000 条 / ls 500 条 / 50KB |

---

## 4. 防线 ②:历史压缩(compaction)算法

核心思路是**非破坏性的"上下文检查点(context checkpoint)"**,而不是简单截断。算法分四步:

1. **选切点(cut point)**:从最近消息往前累加 token,直到达到 `keepRecentTokens` 预算,找到保留边界(`findCutPoint`,`compaction.ts:333`)。
2. **序列化待压缩历史**:把要压缩的消息序列化成纯文本喂给摘要模型(`serializeConversation`,`utils.ts:91`),tool result 截到 `TOOL_RESULT_MAX_CHARS = 2000`(`utils.ts:74`)。
3. **生成结构化摘要**:固定 Markdown 模板 + 文件操作元数据。
4. **非破坏性落盘 + 视图替换**:压缩结果 append 到会话树叶子,原始消息**不删除**,靠 `defaultContextEntryTransform` 在构建上下文时替换。

### 保留哪些消息:按 token 预算 + turn 边界

- **保留最近 ~20000 tokens** 消息(从末尾向前累加,`compaction.ts:347`)。
- **只在合法边界切**:合法切点 = `user` / `assistant` / `bashExecution` / `custom` / `branchSummary` / `compactionSummary`;**`toolResult` 不能作为切点**(`findValidCutPoints`,`compaction.ts:265`)——避免 toolCall 与对应 toolResult 被拆散。
- **system prompt 不在消息历史里**,由 `SUMMARIZATION_SYSTEM_PROMPT` 单独传入,不受压缩影响。

**Split-turn 处理**(精妙处,`compaction.ts:580`):如果 token 预算恰好把一个 turn 从中间切开,会把该 turn 前缀用 `TURN_PREFIX_SUMMARIZATION_PROMPT`(`:612`)单独轻量摘要,拼到主摘要后面,而不是粗暴丢弃。

### 摘要 Prompt:结构化 7 节 Markdown 模板

摘要**不是一段自由文字**,而是强制固定结构(`SUMMARIZATION_PROMPT`,`compaction.ts:387`):

```
## Goal
## Constraints & Preferences
## Progress
   ### Done
   ### In Progress
   ### Blocked
## Key Decisions
## Next Steps
## Critical Context
```

Prompt 反复强调 **`Preserve exact file paths, function names, and error messages`**——防止摘要丢掉关键工程细节。

摘要末尾追加**文件操作元数据**(`formatFileOperations`,`utils.ts:62`):
```
<read-files>...</read-files>
<modified-files>...</modified-files>
```
这些从 assistant 的 toolCall(read/write/edit 的 path 参数)中抽取累积(`extractFileOpsFromMessage`,`utils.ts:24`),跨多次压缩合并。

### 压缩后怎么放回:**追加而非替换**

- **存储层(落盘)**:`session.appendCompaction()`(`session.ts:244`)把结果作为新的 `compaction` 类型树节点 append 到当前叶子。非破坏性,完整历史保留(支持 undo / 审计 / 分支回看)。
- **上下文层(LLM 视图)**:`defaultContextEntryTransform`(`session.ts:57`)在构建上下文时丢弃 `firstKeptEntryId` 之前的所有原始消息,用 compaction 摘要条目替代。

→ 构建出的上下文 = `[compaction摘要] + [firstKeptEntryId 到 compaction 之间保留的消息] + [compaction 之后的新消息]`

### 迭代压缩:增量更新而非全量重写

**有迭代压缩**。`prepareCompaction`(`compaction.ts:544`)每次都找上一次的 compaction 条目(`prevCompactionIndex`):

- 取出上次摘要作为 `previousSummary`
- 把本次待压缩范围起点(`boundaryStart`)设为上次 compaction 的 `firstKeptEntryId`——本次只摘要"自上次压缩后新增的那段"
- 当 `previousSummary` 存在时,改用 `UPDATE_SUMMARIZATION_PROMPT`(`compaction.ts:420`),要求模型 `PRESERVE all existing information`,在旧摘要基础上增量更新(In Progress 移到 Done、更新 Next Steps 等),**而不是从头重写**

文件操作元数据也跨压缩合并(`extractFileOperations`,`compaction.ts:35`)。

### branch-summarization vs 普通 compaction

Pi 的会话是**树形结构**(可分叉/切换),不是单链。

| | Compaction | Branch Summarization |
|---|---|---|
| **场景** | 同一条线性对话太长 | 用户从分支 A **导航**到分支 B(分叉点之后的 A 部分将被"离开") |
| **触发** | token 超阈值 / 溢出 | `navigateTree()` 时,oldLeaf 到公共祖先之间的独有路径 |
| **保留什么** | 保留近期消息 | 目标分支原样保留,只摘要被离开的分支 |
| **落盘类型** | `compaction` 条目 | `branch_summary` 条目 |
| **Prompt** | 同一套七节模板 | `BRANCH_SUMMARY_PROMPT`(`branch-summarization.ts:169`),针对"探索过的分支"语境 |

"branch" 指会话树上的**分叉分支**——把被放弃的那条分支压缩成摘要,作为上下文带回当前分支。算法上 `collectEntriesForBranchSummary`(`branch-summarization.ts:67`)找两条路径的最近公共祖先,只摘要公共祖先之后 oldLeaf 侧的独有部分。

---

## 5. 防线 ③:触发策略

### Compaction 触发点(全部在 `AgentSession`,不在主循环)

`_checkCompaction`(`agent-session.ts:1935`)是核心,**条件触发,非每轮**。两个调用点:

| 调用点 | 行号 | 时机 |
|---|---|---|
| `_handlePostAgentRun` | `agent-session.ts:1084` | **agent_end 之后**(在 `while (await _handlePostAgentRun())` 循环里) |
| `prompt` | `agent-session.ts:1189` | 用户发下一条 prompt **之前** |

### 两个触发路径

**Case 1 — Overflow(被动兜底)**:`isContextOverflow`(`packages/ai/src/utils/overflow.ts:129`)
- LLM 返回 error 且 errorMessage 匹配 `OVERFLOW_PATTERNS`(各 provider 的 "prompt is too long" / "exceeds context window"),**且不匹配** `NON_OVERFLOW_PATTERNS`(限流/429)
- 或 silent overflow:`stopReason=stop` 但 `usage.input + cacheRead > contextWindow`(z.ai 风格)
- 行为:压缩 + **若出错则 compact-and-retry 一次**(`_overflowRecoveryAttempted` 标志位防无限重试,`:1985`)。成功响应的 overflow 只压缩不重试。**最多重试一次**。

**Case 2 — Threshold(主动)**:`shouldCompact`(`compaction.ts:209`)
```ts
shouldCompact(contextTokens, contextWindow, settings):
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
```

### Token 用量怎么获得

**优先用 LLM 响应的 usage 字段**(`calculateContextTokens`,`compaction.ts:120`):
```ts
usage.totalTokens || (usage.input + usage.output + usage.cacheRead + usage.cacheWrite)
```

**没有 usage 时用启发式估算**(`estimateTokens`,`compaction.ts:240`):文本 = `chars/4`,图片 = `4800` chars。注释明确"conservative (overestimates tokens)"——对代码会**系统性高估**。

`estimateContextTokens`(`compaction.ts:176`):取**最后一条有效 assistant** 的 usage 作为基线,之后的消息逐条估算累加。

### Compaction 怎么"注入"回主循环

不需要在主循环插队,走 session 持久化:
1. `_runAutoCompaction`(`agent-session.ts:2029`)→ `harness.compact()`(`agent-harness.ts:686`)→ `session.appendCompaction()`
2. 主循环下一轮 `prepareNextTurn` → `session.buildContext()`:读到 session 树里的 compaction entry,展开成一条 `compactionSummary` message **替换掉被压缩的历史段**
3. `agent-loop.ts` 对压缩**完全无感**——它只看到 `context.messages` 变短了

---

## 6. 最值得抄的 5 个设计决策

1. **非破坏性 + 视图变换**:压缩只 append 摘要节点,靠 context-builder 做替换,完整历史可回溯。优于直接删消息。
2. **双触发**:主动阈值(平滑)+ 被动溢出(兜底,自动重试一次)。
3. **turn 边界对齐 + split-turn 单独摘要前缀**:不破坏 toolCall/toolResult 配对,不粗暴截断半句话。
4. **结构化摘要模板 + 硬约束保留路径/函数名/错误信息**:防止 LLM 摘要丢失工程关键细节。
5. **增量更新而非全量重写**:每次只摘要新增段,在旧摘要上演进,**避免反复压缩导致信息雪崩丢失**(最聪明的一笔)。
6. **文件操作元数据旁路记录**:从 toolCall 抽 read/modified 文件列表作为结构化侧带信息,弥补文本摘要的结构性损失。

---

## 7. ⚠️ Pi 自己的一个设计不对称(别踩)

存在**两套** `estimateContextTokens`,行为不同:

| 实现 | 算 systemPrompt? | 算 tools schema? | 用在哪 |
|---|---|---|---|
| `compaction.ts:176` | **否** | **否** | `_checkCompaction` 触发判断用的 `contextTokens` |
| `packages/ai/src/utils/estimate.ts:114` | 是(`:134`) | 是(`estimateToolsTokens`) | `getContextUsage` → UI 显示百分比 |

**后果**:UI 百分比显示包含了 systemPrompt + tools,但**触发压缩的判断不包含**。如果 system prompt + tool schemas 很大(像 Claude Code 这种几十个工具),实际占用会比触发判断感知的更高 → **触发会比显示更晚**。

fagent 实现时把 systemPrompt+tools 也算进触发判断会更准。

---

## 8. 回到痛点 + 给 fagent 的建议

### "上下文一会就满"的根因

1. **fagent 根本没 compaction**——只搬了 `AgentHarness` 骨架,压缩逻辑在 coding-agent 层(L3),没搬。历史只增不减,必然很快爆。
2. **工具输出没截断**——如果 read 读整文件、bash 输出全塞进去,几个大文件 + 几次构建日志就把窗口吃光。

### 实施 priority(按性价比排)

| 优先级 | 做什么 | 借 Pi 哪块 |
|---|---|---|
| 🔴 P0 | **加工具输出截断**:read 保头+offset、bash 保尾+落 `/tmp` | `tools/truncate.ts` + `output-accumulator.ts` |
| 🔴 P0 | **加 compaction**:先做最简版(摘要旧消息),保最近 ~20k | `compaction.ts` 的 `findCutPoint` + 7 节 prompt |
| 🟡 P1 | **增量更新**:第二次压缩走 UPDATE prompt,别每次从头重写 | `UPDATE_SUMMARIZATION_PROMPT` |
| 🟡 P1 | **文件元数据侧带**:抽 read/write 路径挂摘要末尾 | `extractFileOpsFromMessage` |
| 🟢 P2 | **调阈值**:Pi 默认 92% 偏晚,窗口小可把 `reserveTokens` 调大点早压 | `CompactionSettings` |

---

## 9. 关键文件路径速查(本地 `../pi`)

**Compaction 核心:**
- `/home/yangjie2024/work/cankao/pi/packages/agent/src/harness/compaction/compaction.ts` — 核心算法(`:111` 常量、`:209` shouldCompact、`:333` findCutPoint、`:387` SUMMARIZATION_PROMPT、`:420` UPDATE_SUMMARIZATION_PROMPT)
- `/home/yangjie2024/work/cankao/pi/packages/agent/src/harness/compaction/branch-summarization.ts`
- `/home/yangjie2024/work/cankao/pi/packages/agent/src/harness/compaction/utils.ts` — 序列化 + 文件操作抽取(`:24` extractFileOpsFromMessage、`:62` formatFileOperations、`:74` TOOL_RESULT_MAX_CHARS)

**Session 落盘与上下文重建:**
- `/home/yangjie2024/work/cankao/pi/packages/agent/src/harness/session/session.ts` — `:57` defaultContextEntryTransform、`:244` appendCompaction

**自动触发(coding-agent 应用层):**
- `/home/yangjie2024/work/cankao/pi/packages/coding-agent/src/core/agent-session.ts` — `:1935` _checkCompaction、`:1063` _handlePostAgentRun、`:2029` _runAutoCompaction、`:3111` getContextUsage

**主循环:**
- `/home/yangjie2024/work/cankao/pi/packages/agent/src/agent-loop.ts` — `:155` runLoop、`:281` streamAssistantResponse
- `/home/yangjie2024/work/cankao/pi/packages/agent/src/harness/agent-harness.ts` — `:435` prepareNextTurn、`:686` compact()

**工具输出截断:**
- `/home/yangjie2024/work/cankao/pi/packages/coding-agent/src/core/tools/truncate.ts`
- `/home/yangjie2024/work/cankao/pi/packages/coding-agent/src/core/tools/output-accumulator.ts`
- `/home/yangjie2024/work/cankao/pi/packages/coding-agent/src/core/tools/read.ts`
- `/home/yangjie2024/work/cankao/pi/packages/coding-agent/src/core/tools/bash.ts`

**溢出检测与 token 估算:**
- `/home/yangjie2024/work/cankao/pi/packages/ai/src/utils/overflow.ts` — `:129` isContextOverflow
- `/home/yangjie2024/work/cankao/pi/packages/ai/src/utils/estimate.ts` — `:114` 带 systemPrompt/tools 的估算(UI 用)
