// Verify the workspace feature (config.ts + trace.ts dataDir) without needing the LLM/REPL.
// Uses a throwaway FAGENT_HOME so the real ~/.fagent is never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { getWorkspace, listWorkspaces, migrateWorkspace, parseWorkspaceArg, touchWorkspace } from "../src/config.ts";
import { beginLoop, saveToolTrace } from "../src/ai/utils/trace.ts";

const home = mkdtempSync(join(tmpdir(), "fa-home-"));
process.env.FAGENT_HOME = home;

let pass = 0;
let fail = 0;
const ok = (c: unknown, m: string) => {
	if (c) {
		pass++;
		console.log(`  \x1b[32m✓\x1b[0m ${m}`);
	} else {
		fail++;
		console.log(`  \x1b[31m✗\x1b[0m ${m}`);
	}
};

console.log("config.ts:");
const w = getWorkspace("/tmp/projA");
ok(w.ws === "/tmp/projA", "ws 为绝对路径");
ok(w.home === home, "home = FAGENT_HOME");
ok(w.sessionsRoot === join(home, "workspaces"), "sessionsRoot = home/workspaces (绝对)");
ok(w.dataDir === join(home, "workspaces", w.bucket, "data"), "dataDir 在桶下");
ok(w.bucket === "--tmp-projA--", `bucket = encodeCwd (got ${w.bucket})`);

const w2 = touchWorkspace("/tmp/projA");
ok(existsSync(w2.metaFile), "touchWorkspace 建 meta.json");
const meta = JSON.parse(readFileSync(w2.metaFile, "utf8"));
ok(meta.path === "/tmp/projA" && meta.name === "projA", "meta path/name 正确");
ok(meta.createdAt && meta.lastUsed, "meta 有 createdAt/lastUsed");

touchWorkspace("/tmp/projB");
const list = listWorkspaces();
ok(list.length === 2, `listWorkspaces 返回 2 个 (got ${list.length})`);
ok(list.every((m) => m.lastUsed && m.path), "每条有 lastUsed + path");
ok(w.bucket !== getWorkspace("/tmp/projB").bucket, "两个 workspace 桶不同(隔离)");

console.log("\nparseWorkspaceArg:");
ok(parseWorkspaceArg(["--workspace", "/x"]).explicit === "/x", "--workspace <path>");
ok(parseWorkspaceArg(["--workspace=/y"]).explicit === "/y", "--workspace=<path>");
ok(parseWorkspaceArg(["-w", "/z"]).explicit === "/z", "-w <path>");
ok(parseWorkspaceArg(["--migrate"]).migrate === true, "--migrate");
const empty = parseWorkspaceArg([]);
ok(empty.explicit === undefined && !empty.migrate, "空 argv");

console.log("\ntrace.ts dataDir threading:");
const loopId = beginLoop(w.dataDir);
saveToolTrace({ toolCallId: "t1", toolName: "bash", args: { cmd: "echo" }, result: "hi", isError: false, durationMs: 5 });
const dayDir = join(w.dataDir, loopId.slice(0, 8));
ok(existsSync(join(dayDir, `${loopId}.jsonl`)), "trace 落在 WS.dataDir (home 桶, 不是 ./data)");
ok(readFileSync(join(dayDir, `${loopId}.jsonl`), "utf8").includes('"toolName":"bash"'), "trace 内容正确");

console.log("\nmigrateWorkspace:");
const srcProj = mkdtempSync(join(tmpdir(), "fa-src-"));
const srcW = getWorkspace(srcProj);
// 预置老布局:<srcProj>/.sessions/<bucket>/sess.jsonl + <srcProj>/data/20260101/loop.jsonl
mkdirSync(join(srcProj, ".sessions", srcW.bucket), { recursive: true });
writeFileSync(join(srcProj, ".sessions", srcW.bucket, "sess.jsonl"), '{"v":1}\n');
mkdirSync(join(srcProj, "data", "20260101"), { recursive: true });
writeFileSync(join(srcProj, "data", "20260101", "loop.jsonl"), '{"type":"model"}\n');
migrateWorkspace(srcProj);
ok(existsSync(join(srcW.sessionsRoot, srcW.bucket, "sess.jsonl")), "session 文件搬到 home 桶");
ok(existsSync(join(srcW.sessionsRoot, srcW.bucket, "data", "20260101", "loop.jsonl")), "data 文件搬到 home 桶/data");
ok(!existsSync(join(srcProj, ".sessions", srcW.bucket, "sess.jsonl")), "老 session 原处已清");
ok(existsSync(join(srcW.metaFile)), "migrate 后写 meta.json");
rmSync(srcProj, { recursive: true, force: true });

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
rmSync(home, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
