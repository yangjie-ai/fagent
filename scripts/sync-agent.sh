#!/usr/bin/env bash
# 把 pi packages/agent/src/ 的 *.ts 全量同步到 src/agent/，保持 fagent 的 agent core 与 pi
# 字节级一致（纯净镜像）。非 .ts 元文件（如 README.md）保留。
#
# fagent 的所有定制都不在 src/agent/：
#   - 重试    → src/ai/api/openai-completions.ts（openai SDK maxRetries）
#   - workspace/应用逻辑 → src/config.ts + src/main.ts
#   - 工具    → src/tools/
# 详见 src/agent/README.md。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_SRC="${FAGENT_PI_ROOT:-$ROOT/../pi}/packages/agent/src"
DEST="$ROOT/src/agent"

if [ ! -d "$PI_SRC" ]; then
	echo "pi agent src 未找到: $PI_SRC" >&2
	echo "设置 FAGENT_PI_ROOT 指向 pi 仓库根，或调整脚本里的路径。" >&2
	exit 1
fi

# 1) 清掉 DEST 下所有 .ts（保留 README.md 等非 .ts 元文件）
find "$DEST" -name '*.ts' -delete

# 2) 从 pi 全量拷贝 .ts（保持子目录结构）
( cd "$PI_SRC" && find . -name '*.ts' -print0 ) | while IFS= read -r -d '' f; do
	mkdir -p "$DEST/$(dirname "$f")"
	cp "$PI_SRC/$f" "$DEST/$f"
done

echo "✓ 同步完成: $PI_SRC  ->  $DEST  (仅 *.ts)"
echo "下一步: npm run typecheck   并用 cmp 抽查 src/agent 与 pi 是否字节级一致"
