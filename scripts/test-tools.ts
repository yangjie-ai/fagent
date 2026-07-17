/**
 * Runtime smoke tests for the ported tools.
 * Run: npm run test:tools   (or: npx tsx scripts/test-tools.ts)
 *
 * Focus: output-control behavior (the whole point of the port) + correctness.
 * Fixtures are created in a temp dir (and cwd is switched there) so grep/find/ls
 * and .gitignore resolution behave realistically. Nothing is written to the repo.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`断言失败: ${msg}`);
}
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
	return r.content[0]?.text ?? "";
}
async function test(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  \x1b[32m✓\x1b[0m ${name}`);
	} catch (e) {
		failed++;
		const msg = e instanceof Error ? e.message : String(e);
		console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${msg.replace(/\n/g, "\n      ")}`);
		failures.push(name);
	}
}

// ─── fixtures ───────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "fagent-tools-"));
process.chdir(dir);
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "small.txt"), "line1\nline2\nline3\n");
writeFileSync(join(dir, "big.txt"), Array.from({ length: 5000 }, (_, i) => `L${i + 1} ${"x".repeat(25)}`).join("\n"));
writeFileSync(join(dir, "minified.txt"), "a".repeat(60000)); // single 60KB line, no newline
writeFileSync(join(dir, "fruits.txt"), "apple\nbanana\ncherry\nApple\nMango\n");
writeFileSync(join(dir, "keep.txt"), "secret-value\n");
writeFileSync(join(dir, "ignored.txt"), "secret-value\n");
writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
writeFileSync(join(dir, "longline.txt"), `${"z".repeat(650)}needle${"z".repeat(50)}\n`);
writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
writeFileSync(join(dir, "src", "c.ts"), "export const c = 3;\n");
writeFileSync(join(dir, "e1.txt"), "alpha\nbeta\ngamma\n");
writeFileSync(join(dir, "e2.txt"), "He said “hello” world\n"); // smart quotes
writeFileSync(join(dir, "e3.txt"), "foo\nbar\nfoo\n");

console.log(`\nfixtures: ${dir}\n`);

// ─── read ────────────────────────────────────────────────────────────────────
console.log("read:");
await test("小文件完整返回", async () => {
	const r = await readTool.execute("t", { path: "small.txt" });
	assert(textOf(r) === "line1\nline2\nline3\n", `小文件应原样返回(含尾换行): ${JSON.stringify(textOf(r))}`);
});
await test("大文件被截断 + 续读提示", async () => {
	const r = await readTool.execute("t", { path: "big.txt" });
	const t = textOf(r);
	assert(t.includes("Use offset="), `缺少续读提示: ${t.slice(-80)}`);
	assert(!t.includes("L5000"), "应该没读到最后一行");
});
await test("offset 翻页读到尾部", async () => {
	const r = await readTool.execute("t", { path: "big.txt", offset: 4500 });
	const t = textOf(r);
	assert(t.includes("L4500"), "应从 L4500 开始");
	assert(t.includes("L5000"), "应读到最后一行");
});
await test("limit 限制行数", async () => {
	const r = await readTool.execute("t", { path: "big.txt", limit: 10 });
	const t = textOf(r);
	assert(t.includes("Use offset=11"), `应提示 offset=11: ${t.slice(-60)}`);
});
await test("首行超 50KB → sed 兜底", async () => {
	const r = await readTool.execute("t", { path: "minified.txt" });
	const t = textOf(r);
	assert(t.includes("exceeds"), `应提示超限: ${t}`);
	assert(t.includes("sed -n"), "应给 sed 兜底命令");
});
await test("offset 越界 → 抛错", async () => {
	await assertRejects(() => readTool.execute("t", { path: "small.txt", offset: 999 }), "beyond end of file");
});

// ─── bash ────────────────────────────────────────────────────────────────────
console.log("\nbash:");
await test("普通命令 exit 0", async () => {
	const r = await bashTool.execute("t", { command: "echo hello" });
	assert(textOf(r).trim() === "hello", `got: ${JSON.stringify(textOf(r))}`);
	assert((r.details as any).exitCode === 0, "exitCode 应为 0");
});
await test("长输出截断 + /tmp 落盘", async () => {
	const r = await bashTool.execute("t", { command: "seq 1 5000" });
	const t = textOf(r);
	assert(t.includes("Showing last"), `应提示截断: ${t.slice(-80)}`);
	assert(t.includes("5000"), "应含末行");
	const path = (r.details as any).fullOutputPath;
	assert(path && existsSync(path), `临时文件应存在: ${path}`);
	assert(readFileSync(path, "utf-8").trim().split("\n").length === 5000, "全量应为 5000 行");
});
await test("非零退出 → 抛错且含输出", async () => {
	await assertRejects(
		() => bashTool.execute("t", { command: "sh -c 'echo oops >&2; exit 7'" }),
		"exited with code 7",
	);
});
await test("超时 → 抛错", async () => {
	await assertRejects(() => bashTool.execute("t", { command: "sleep 5", timeout: 1 }), "timed out");
});

// ─── grep ────────────────────────────────────────────────────────────────────
console.log("\ngrep:");
await test("字面量匹配(区分大小写)", async () => {
	const r = await grepTool.execute("t", { pattern: "apple", path: "fruits.txt", literal: true });
	const t = textOf(r);
	assert(t.includes("apple") && !t.includes("Apple"), "只匹配小写 apple");
});
await test("ignoreCase 匹配大小写", async () => {
	const r = await grepTool.execute("t", { pattern: "apple", path: "fruits.txt", literal: true, ignoreCase: true });
	assert(textOf(r).includes("Apple"), "应匹配大写 Apple");
});
await test("尊重 .gitignore", async () => {
	const r = await grepTool.execute("t", { pattern: "secret-value", path: "." });
	const t = textOf(r);
	assert(t.includes("keep.txt"), "应命中非忽略文件");
	assert(!t.includes("ignored.txt"), "不应命中被忽略文件");
});
await test("长行截断到 500 字符", async () => {
	const r = await grepTool.execute("t", { pattern: "needle", path: "longline.txt" });
	assert(textOf(r).includes("truncated"), "应提示长行被截断");
});

// ─── find ────────────────────────────────────────────────────────────────────
console.log("\nfind:");
await test("glob 匹配", async () => {
	const r = await findTool.execute("t", { pattern: "*.ts", path: "src" });
	const t = textOf(r);
	assert(t.includes("a.ts") && t.includes("b.ts") && t.includes("c.ts"), `应列出 3 个 ts: ${t}`);
});

// ─── ls ──────────────────────────────────────────────────────────────────────
console.log("\nls:");
await test("目录加 / 后缀", async () => {
	const r = await lsTool.execute("t", { path: "." });
	const t = textOf(r);
	assert(t.includes("src/"), "目录应有 / 后缀");
	assert(t.includes("small.txt"), "应列出文件");
});
await test("limit 限制条数", async () => {
	const r = await lsTool.execute("t", { path: ".", limit: 2 });
	const t = textOf(r);
	assert(/limit|truncat|showing/i.test(t) || t.split("\n").filter(Boolean).length <= 3, "应触发限制提示或条数受限");
});

// ─── edit ────────────────────────────────────────────────────────────────────
console.log("\nedit:");
await test("精确单处替换", async () => {
	await editTool.execute("t", { path: "e1.txt", edits: [{ oldText: "beta", newText: "BETA" }] });
	const t = textOf(await readTool.execute("t", { path: "e1.txt" }));
	assert(t.includes("BETA") && !t.includes("beta"), `替换结果: ${t}`);
});
await test("模糊匹配智能引号", async () => {
	await editTool.execute("t", {
		path: "e2.txt",
		edits: [{ oldText: 'He said "hello" world', newText: 'He said "hi" world' }],
	});
	const t = textOf(await readTool.execute("t", { path: "e2.txt" }));
	assert(t.includes("hi"), `应模糊匹配成功: ${t}`);
});
await test("未找到 → 抛错", async () => {
	await assertRejects(
		() => editTool.execute("t", { path: "e1.txt", edits: [{ oldText: "ZZZ", newText: "yyy" }] }),
		"",
	);
});
await test("多处匹配 → 抛错", async () => {
	await assertRejects(
		() => editTool.execute("t", { path: "e3.txt", edits: [{ oldText: "foo", newText: "FOO" }] }),
		"",
	);
});

// ─── write ───────────────────────────────────────────────────────────────────
console.log("\nwrite:");
await test("写入并读回", async () => {
	await writeTool.execute("t", { path: "w1.txt", content: "written\n" });
	const t = textOf(await readTool.execute("t", { path: "w1.txt" }));
	assert(t === "written\n", `读回内容不符: ${JSON.stringify(t)}`);
});

// ─── summary ─────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failures.length) console.log(`失败: ${failures.join(", ")}`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

// ─── helpers ─────────────────────────────────────────────────────────────────
async function assertRejects(fn: () => Promise<unknown>, msgIncludes: string): Promise<void> {
	try {
		await fn();
	} catch (e) {
		const m = e instanceof Error ? e.message : String(e);
		if (msgIncludes && !m.includes(msgIncludes)) {
			throw new Error(`抛错了但消息不含 "${msgIncludes}": ${m}`);
		}
		return;
	}
	throw new Error("预期抛错但成功了");
}
