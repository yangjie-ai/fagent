/**
 * Tiny zero-dependency viewer server. Serves viewer.html and a JSON list of every
 * trace file under ./data so the page can auto-load on open (browsers can't read
 * local paths on their own). Run `npm run view`, then open the printed URL.
 */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspace, parseWorkspaceArg } from "./config.ts";

const PORT = Number(process.env.VIEW_PORT) || 4789;
const WS = getWorkspace(parseWorkspaceArg(process.argv.slice(2)).explicit);
const VIEWER_HTML = fileURLToPath(new URL("../viewer.html", import.meta.url));

/** Recursively collect every .json / .jsonl trace under `dir`. */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walk(p, out);
		else if (e.name.endsWith(".json") || e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

const server = createServer(async (req, res) => {
	try {
		if (req.url === "/api/traces") {
			let files: string[] = [];
			try {
				files = await walk(WS.dataDir);
			} catch {
				// No data/ yet → empty list, page shows the empty state.
			}
			files.sort();
			const pairs = await Promise.all(
				files.map(async (p) => ({ name: basename(p), text: await readFile(p, "utf8") })),
			);
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(pairs));
			return;
		}
		if (req.url === "/" || req.url === "/viewer.html") {
			const html = await readFile(VIEWER_HTML, "utf8");
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
	} catch (e) {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
		res.end(String(e));
	}
});

server.listen(PORT, () => {
	console.log(`viewer → http://localhost:${PORT}   (data: ${WS.dataDir})`);
});
