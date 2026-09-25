import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, SimpleStreamOptions, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { EphemeralToolCallInfo } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MAX_SIDE_QUESTION_TOOL_ROUNDS } from "@oh-my-pi/pi-coding-agent/session/side-question-tools";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const SECRET = "sk-planted-secret-4242";

function tool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `mock ${name}`,
		parameters: type({ "path?": "string", "command?": "string" }),
		execute,
	};
}

function callMessage(calls: Array<{ name: string; arguments: Record<string, unknown> }>): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: calls.map((call, index): ToolCall => ({ type: "toolCall", id: `call-${index}-${call.name}`, ...call })),
		stopReason: "toolUse",
	};
}

interface Harness {
	session: AgentSession;
	requests: Array<{ messages: string; toolChoice: SimpleStreamOptions["toolChoice"] }>;
	executed: string[];
}

describe("read-only side-question lookups", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	/** `replies` are returned in order, the last one repeating. */
	function harness(replies: AssistantMessage[]): Harness {
		const requests: Harness["requests"] = [];
		const executed: string[] = [];
		const sideTool = (name: string, text: string) =>
			tool(name, async () => {
				executed.push(name);
				return { content: [{ type: "text", text }] };
			});
		// Main agent tools: only their names matter (a lookup must be active in the main session).
		const mainTools = ["read", "grep", "bash", "rewind", "todo", "memory_edit"].map(name =>
			tool(name, async () => {
				throw new Error(`main-session ${name} must never run for a side question`);
			}),
		);
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model: getBundledModel("openai", "gpt-4o-mini"), systemPrompt: [], tools: mainTools },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				getApiKey: async () => "key",
				resolver: () => async () => "key",
				authStorage: { usage: { ingestHeaders: () => {} }, oauth: { identity: () => undefined } },
				hasLazyRuntimeMetadata: () => false,
			} as never,
			obfuscator: new SecretObfuscator([{ type: "plain", content: SECRET }]),
			// Side-owned instances, including write/session tools that must still be refused.
			advisorTools: [
				sideTool("read", `API_KEY=${SECRET}\nPORT=8080`),
				sideTool("grep", "no matches"),
				sideTool("bash", "ran"),
				sideTool("rewind", "rewound"),
				sideTool("todo", "updated"),
				sideTool("memory_edit", "saved"),
			],
			sideStreamFn: (_model, context, options) => {
				// Snapshot the messages sent; tool definitions carry functions and are not needed here.
				requests.push({ messages: JSON.stringify(context.messages), toolChoice: options?.toolChoice });
				const message = replies[Math.min(requests.length - 1, replies.length - 1)]!;
				const stream = new AssistantMessageEventStream();
				for (const block of message.content) {
					if (block.type === "text")
						stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
				}
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				return stream;
			},
		});
		sessions.push(session);
		return { session, requests, executed };
	}

	it("runs permitted lookups on side tools, refuses everything else, and obfuscates what it read", async () => {
		const h = harness([
			callMessage([
				{ name: "read", arguments: { path: ".env" } },
				{ name: "bash", arguments: { command: "rm -rf build" } },
				{ name: "rewind", arguments: {} },
				{ name: "todo", arguments: {} },
				{ name: "memory_edit", arguments: {} },
			]),
			createAssistantMessage("PORT is 8080."),
		]);
		const seen: EphemeralToolCallInfo[] = [];

		const result = await h.session.runEphemeralTurn({
			promptText: "What port does .env set?",
			toolPolicy: "read-only",
			onToolCall: call => seen.push(call),
		});

		expect(result.replyText).toBe("PORT is 8080.");
		expect(h.executed).toEqual(["read"]);
		expect(seen.map(call => [call.name, call.allowed])).toEqual([
			["read", true],
			["bash", false],
			["rewind", false],
			["todo", false],
			["memory_edit", false],
		]);
		expect(h.requests).toHaveLength(2);
		const followUp = h.requests[1]!.messages;
		expect(followUp).toContain("PORT=8080");
		expect(followUp).toContain("is not available in a side question");
		// The file's secret reaches the provider only in obfuscated form.
		expect(followUp).not.toContain(SECRET);
		// Nothing lands in the main session.
		expect(h.session.messages).toHaveLength(0);
	});

	it("keeps the default side turn tool-free", async () => {
		const h = harness([
			callMessage([{ name: "read", arguments: { path: ".env" } }]),
			createAssistantMessage("never"),
		]);

		await h.session.runEphemeralTurn({ promptText: "What port?" });

		expect(h.executed).toEqual([]);
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]!.messages).toContain("tools NOT available this turn");
	});

	it("stops looking up after the round limit and forces a tool-free answer", async () => {
		const h = harness([callMessage([{ name: "grep", arguments: { path: "src" } }])]);
		const seen: EphemeralToolCallInfo[] = [];

		await h.session.runEphemeralTurn({
			promptText: "Search forever",
			toolPolicy: "read-only",
			onToolCall: call => seen.push(call),
		});

		expect(h.executed).toHaveLength(MAX_SIDE_QUESTION_TOOL_ROUNDS);
		expect(seen.at(-1)?.allowed).toBe(false);
		expect(h.requests).toHaveLength(MAX_SIDE_QUESTION_TOOL_ROUNDS + 2);
		expect(h.requests.at(-1)?.toolChoice).toBe("none");
		expect(h.requests.at(-1)!.messages).toContain("Lookup limit for this side question reached");
	});
});
