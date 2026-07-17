/**
 * Workspace 解析。把 fagent 的状态(sessions/traces)集中到 home
 * (~/.fagent/workspaces/<encodeCwd(ws)>/),不再写进目标项目;一个 workspace =
 * 一个目标项目。所有路径在 home 下是绝对的,只有 ws 本身跟 process.cwd()。
 *
 * 顺序约定:getWorkspace/touchWorkspace/migrateWorkspace 都必须在 process.chdir
 * 之前调用(resolve 用当前 cwd)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { encodeCwd } from "./agent/harness/session/jsonl-repo.ts";

export interface Workspace {
	/** 目标项目绝对路径(identity)。 */
	ws: string;
	/** fagent home(~/.fagent)。 */
	home: string;
	/** encodeCwd(ws),workspace 桶名。 */
	bucket: string;
	/** ~/.fagent/workspaces(绝对,传给 JsonlSessionRepo 的 sessionsRoot)。 */
	sessionsRoot: string;
	/** ~/.fagent/workspaces/<bucket>/data(trace 输出目录)。 */
	dataDir: string;
	/** ~/.fagent/workspaces/<bucket>/meta.json。 */
	metaFile: string;
}

export interface WorkspaceMeta {
	path: string;
	name: string;
	createdAt: string;
	lastUsed: string;
}

/** fagent home:env FAGENT_HOME 覆盖,默认 ~/.fagent。 */
export function getFagentHome(): string {
	return process.env.FAGENT_HOME || join(homedir(), ".fagent");
}

/**
 * 解析 workspace。ws 始终是绝对路径。sessionsRoot/dataDir 都是 home 下绝对路径,
 * 不随 cwd 变(这样 process.chdir(ws) 后仓库状态仍落在 home,不会跑进目标项目)。
 */
export function getWorkspace(explicit?: string): Workspace {
	const ws = resolve(explicit ?? process.cwd());
	const home = getFagentHome();
	const bucket = encodeCwd(ws);
	const sessionsRoot = join(home, "workspaces");
	const dataDir = join(sessionsRoot, bucket, "data");
	const metaFile = join(sessionsRoot, bucket, "meta.json");
	return { ws, home, bucket, sessionsRoot, dataDir, metaFile };
}

/** 确保 workspace 桶存在并写/更新 meta.json(encodeCwd 不可逆,meta.json 是真实路径唯一来源),返回 Workspace。 */
export function touchWorkspace(ws: string): Workspace {
	const w = getWorkspace(ws);
	const bucketDir = join(w.sessionsRoot, w.bucket);
	mkdirSync(bucketDir, { recursive: true });
	const now = new Date().toISOString();
	let meta: WorkspaceMeta;
	if (existsSync(w.metaFile)) {
		try {
			meta = JSON.parse(readFileSync(w.metaFile, "utf-8")) as WorkspaceMeta;
		} catch {
			meta = { path: ws, name: basename(ws), createdAt: now, lastUsed: now };
		}
		meta.lastUsed = now;
	} else {
		meta = { path: ws, name: basename(ws), createdAt: now, lastUsed: now };
	}
	writeFileSync(w.metaFile, JSON.stringify(meta, null, 2), "utf-8");
	return w;
}

/** 列出所有已知 workspace(按 lastUsed 倒序)。无 meta.json 的桶跳过(路径不可恢复)。 */
export function listWorkspaces(): Array<WorkspaceMeta & { bucket: string }> {
	const sessionsRoot = join(getFagentHome(), "workspaces");
	if (!existsSync(sessionsRoot)) return [];
	const out: Array<WorkspaceMeta & { bucket: string }> = [];
	for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metaFile = join(sessionsRoot, entry.name, "meta.json");
		if (!existsSync(metaFile)) continue;
		try {
			const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as WorkspaceMeta;
			out.push({ ...meta, bucket: entry.name });
		} catch {
			// 损坏的 meta 跳过
		}
	}
	out.sort((a, b) => (b.lastUsed || "").localeCompare(a.lastUsed || ""));
	return out;
}

/** 解析 argv:--workspace <path> / --workspace=<path> / -w <path> / --migrate。 */
export function parseWorkspaceArg(argv: string[]): { explicit?: string; migrate: boolean } {
	let explicit: string | undefined;
	let migrate = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--workspace" || a === "-w") {
			explicit = argv[++i];
		} else if (a.startsWith("--workspace=")) {
			explicit = a.slice("--workspace=".length);
		} else if (a.startsWith("-w=")) {
			explicit = a.slice("-w=".length);
		} else if (a === "--migrate") {
			migrate = true;
		}
	}
	return { explicit, migrate };
}

/**
 * 把老布局(<srccwd>/.sessions/<bucket>/、<srccwd>/data/)搬进 home 桶。best-effort,
 * 从不抛错(单文件 rename 跨设备会失败 → 跳过,留在原处)。必须在 chdir 前调用。
 */
export function migrateWorkspace(explicit?: string): void {
	const srcCwd = resolve(explicit ?? process.cwd());
	const w = getWorkspace(srcCwd);
	const bucketDir = join(w.sessionsRoot, w.bucket);
	mkdirSync(bucketDir, { recursive: true });

	const oldSessions = join(srcCwd, ".sessions", w.bucket);
	let movedSessions = 0;
	if (existsSync(oldSessions)) {
		for (const f of readdirSync(oldSessions)) {
			try {
				renameSync(join(oldSessions, f), join(bucketDir, f));
				movedSessions++;
			} catch {}
		}
	}

	const oldData = join(srcCwd, "data");
	let movedData = 0;
	if (existsSync(oldData)) {
		const newData = join(bucketDir, "data");
		mkdirSync(newData, { recursive: true });
		for (const f of readdirSync(oldData)) {
			try {
				renameSync(join(oldData, f), join(newData, f));
				movedData++;
			} catch {}
		}
	}

	touchWorkspace(srcCwd);
	console.log(`migrate ${srcCwd} → ${bucketDir}  (sessions: ${movedSessions}, data 子项: ${movedData})`);
}
