import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";

export const tools: AgentTool[] = [
	readTool,
	writeTool,
	editTool,
	bashTool,
	grepTool,
	lsTool,
	findTool,
];
