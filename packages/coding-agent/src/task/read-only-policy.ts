import type { AgentDefinition } from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
//
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"wait",
	"grep",
	"glob",
	"find",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"checkpoint",
	"rewind",
]);

// Pure lookups a side question (`/btw`) may run. A strict subset of
// READ_ONLY_TOOL_NAMES: "read" approval tier alone is not enough, because
// todo, memory_edit, retain, checkpoint and rewind change session or memory
// state, and ask/wait/yield steer the main agent. Allowlist, not denylist, so a
// new tool is refused until it is classified here.
export const SIDE_QUESTION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"ast_grep",
	"web_search",
	"recall",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
