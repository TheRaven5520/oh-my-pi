/**
 * Read-only tool execution for side questions (`/btw`): pure lookups run on
 * side-owned tool instances, everything else is refused with an error result.
 * Nothing here touches the main session's history, tools, or caches.
 */
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ToolCall, type ToolResultMessage, toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { SIDE_QUESTION_TOOL_NAMES } from "../task/read-only-policy";
import { schemaDeclaresIntentField } from "../utils/tool-schema";

/** Tool rounds one side question may run before it must answer from what it has. */
export const MAX_SIDE_QUESTION_TOOL_ROUNDS = 8;

/** Why a side-question tool call did not run. */
export type SideQuestionRefusal = "not-allowed" | "round-limit";

function errorResult(call: ToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: Date.now(),
	};
}

/** Tool result for a call the side question may not run. */
export function refuseSideQuestionToolCall(call: ToolCall, reason: SideQuestionRefusal): ToolResultMessage {
	return errorResult(
		call,
		reason === "round-limit"
			? "Lookup limit for this side question reached. Answer now from what you already have."
			: `\`${call.name}\` is not available in a side question. Only read-only lookups (${[...SIDE_QUESTION_TOOL_NAMES].join(", ")}) run here; nothing may be modified. Answer from what you have, or say what the user should run in the main chat.`,
	);
}

/** Keep only the pure lookups in `SIDE_QUESTION_TOOL_NAMES`; nothing else is ever reachable from a side question. */
export function sideQuestionLookupTools(tools: readonly AgentTool[]): ReadonlyMap<string, AgentTool> {
	return new Map(tools.filter(tool => SIDE_QUESTION_TOOL_NAMES.has(tool.name)).map(tool => [tool.name, tool]));
}

/**
 * The side-owned lookup tool for `call`, when the main agent currently has
 * that tool too. `lookupTools` comes from {@link sideQuestionLookupTools} over
 * instances bound to a tool session separate from the main agent's, so reads
 * do not update its snapshot or seen-line caches.
 */
export function resolveSideQuestionTool(
	call: ToolCall,
	lookupTools: ReadonlyMap<string, AgentTool>,
	mainActiveToolNames: ReadonlySet<string>,
): AgentTool | undefined {
	return mainActiveToolNames.has(call.name) ? lookupTools.get(call.name) : undefined;
}

/** Validate and run one permitted lookup; failures become error results, never throws except on abort. */
export async function runSideQuestionToolCall(
	tool: AgentTool,
	call: ToolCall,
	signal: AbortSignal,
	context: AgentToolContext | undefined,
): Promise<ToolResultMessage> {
	// Same argument handling as the main loop: a harness intent field the schema
	// does not declare is metadata, not a tool argument.
	const args = { ...call.arguments };
	if (!schemaDeclaresIntentField(toolWireSchema(tool))) delete args[INTENT_FIELD];
	let validated: Record<string, unknown>;
	try {
		validated = validateToolArguments(tool, { ...call, arguments: args });
	} catch (error) {
		if (!tool.lenientArgValidation) {
			return errorResult(call, error instanceof Error ? error.message : String(error));
		}
		validated = { ...args };
		delete validated.__parseError;
		delete validated.__rawJson;
	}
	let raw: AgentToolResult;
	try {
		raw = await tool.execute(call.id, validated, signal, () => {}, context);
	} catch (error) {
		signal.throwIfAborted();
		return errorResult(call, error instanceof Error ? error.message : String(error));
	}
	signal.throwIfAborted();
	const content = isRecord(raw) && Array.isArray(raw.content) ? raw.content : [];
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
		isError: raw?.isError === true,
		timestamp: Date.now(),
	};
}
