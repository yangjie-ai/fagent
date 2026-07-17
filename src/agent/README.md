# src/agent/ — pi 镜像（冻结实体）

本目录是 [pi](https://github.com/earendil-works/pi) 的 `packages/agent/`（agent core）的**字节级镜像**，通过 `scripts/sync-agent.sh` 从 pi 同步。

**不要在此目录修改代码。** fagent 的所有定制都落在 `src/agent/` 之外：

| 定制 | 落点 |
|---|---|
| LLM 请求重试（transient error） | `src/ai/api/openai-completions.ts`（openai SDK `maxRetries`，读 `RETRY_MAX_ATTEMPTS`） |
| workspace / 应用编排 | `src/config.ts`、`src/main.ts` |
| 工具 | `src/tools/` |
| trace / viewer | `src/ai/utils/trace.ts`、`src/view.ts` |

`encodeCwd` 在 `src/config.ts` 有一份本地副本（pi 版的 `jsonl-repo.ts` 不 export 它），这样本目录能与 pi 保持字节级一致。

## 同步

```bash
# pi 与 fagent 同级（~/work/cankao/{pi,fagent}）时直接：
bash scripts/sync-agent.sh

# 否则指定 pi 根：
FAGENT_PI_ROOT=/path/to/pi bash scripts/sync-agent.sh
```

同步后跑 `npm run typecheck`，并用 `cmp` 抽查与 pi 是否一致。
