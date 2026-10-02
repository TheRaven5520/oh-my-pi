import { describe, expect, it } from "bun:test";
import { type Api, completeSimple, type Model, type ModelSpec, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	PRIVATE_CHAT_TRIGGER,
	PRIVATE_SESSION_HEADER,
	privateSideCall,
	privateSideSessionId,
} from "@oh-my-pi/pi-coding-agent/session/private-side-calls";
import { buildSideAgentHeaders } from "@oh-my-pi/pi-coding-agent/session/side-agent-headers";

const CHAT_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const HEX32 = "0123456789abcdef0123456789abcdef";

function gatewayModel(api: "anthropic-messages" | "openai-responses", provider: string): Model<Api> {
	const anthropic = api === "anthropic-messages";
	return {
		...buildModel({
			id: anthropic ? "claude-haiku-4-5" : "gpt-6-luna",
			name: "gateway model",
			api,
			provider,
			baseUrl: anthropic ? "https://gateway.example/anthropic" : "https://gateway.example/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} as ModelSpec<typeof api>),
		// models.yml `auth: oauth`: Sprilicred's Anthropic route takes the Claude Code request shape.
		isOAuth: anthropic,
	} as Model<Api>;
}

function sse(events: Array<[string | null, unknown]>): Response {
	const body = events
		.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
		.join("");
	return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** Sprilicred's own streamed Anthropic answer (src/proxy/trigger.rs `reply`), or a model's when `tokens` > 0. */
function anthropicReply(text: string, tokens = 0): Response {
	const message = {
		id: `msg_${HEX32}`,
		type: "message",
		role: "assistant",
		model: "claude-haiku-4-5",
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
	};
	return sse([
		["message_start", { type: "message_start", message }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: tokens },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

/** Sprilicred's own streamed Responses answer, or a model's when `tokens` > 0. */
function responsesReply(text: string, tokens = 0): Response {
	const part = { type: "output_text", text, annotations: [], logprobs: [] };
	const item = (status: string, content: unknown[]) => ({
		id: `msg_${HEX32}`,
		type: "message",
		status,
		role: "assistant",
		content,
	});
	const response = (status: string, output: unknown[], usage: unknown) => ({
		id: `resp_${HEX32}`,
		object: "response",
		created_at: 1,
		status,
		model: "gpt-6-luna",
		output,
		usage,
		error: null,
		incomplete_details: null,
	});
	const usage = {
		input_tokens: tokens,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: tokens,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: tokens * 2,
	};
	const ids = { item_id: `msg_${HEX32}`, output_index: 0, content_index: 0 };
	return sse([
		[null, { type: "response.created", response: response("in_progress", [], null) }],
		[null, { type: "response.output_item.added", output_index: 0, item: item("in_progress", []) }],
		[null, { type: "response.content_part.added", ...ids, part: { ...part, text: "" } }],
		[null, { type: "response.output_text.delta", ...ids, delta: text, logprobs: [] }],
		[null, { type: "response.output_text.done", ...ids, text, logprobs: [] }],
		[null, { type: "response.content_part.done", ...ids, part }],
		[null, { type: "response.output_item.done", output_index: 0, item: item("completed", [part]) }],
		[null, { type: "response.completed", response: response("completed", [item("completed", [part])], usage) }],
	]);
}

interface WireRequest {
	headers: Headers;
	body: Record<string, unknown>;
	raw: string;
}

/** A fetch that records every request and answers it with `answer(request, index)`. */
function gateway(answer: (request: WireRequest, index: number) => Response) {
	const requests: WireRequest[] = [];
	const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		const raw = await new Response(init?.body).text();
		const request = { headers: new Headers(init?.headers), body: JSON.parse(raw) as Record<string, unknown>, raw };
		requests.push(request);
		return answer(request, requests.length - 1);
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

function isTrigger(request: WireRequest): boolean {
	const items = (request.body.messages ?? request.body.input) as Array<{ content: unknown }>;
	return items.length === 1 && JSON.stringify(items[0].content).includes(PRIVATE_CHAT_TRIGGER);
}

/** A side call as omp sends it: the chat's own session id and identity, linked to the chat. */
function chatScopedOptions(fetch: typeof globalThis.fetch): SimpleStreamOptions {
	return {
		apiKey: "sk-spr-test",
		sessionId: CHAT_ID,
		promptCacheKey: CHAT_ID,
		metadata: { user_id: JSON.stringify({ device_id: "d", session_id: CHAT_ID }) },
		headers: buildSideAgentHeaders(CHAT_ID, "title"),
		maxTokens: 64,
		fetch,
	};
}

async function sideCall(model: Model<Api>, options: SimpleStreamOptions, role: Parameters<typeof privateSideCall>[2]) {
	const message = await completeSimple(
		model,
		{ messages: [{ role: "user", content: "Name this chat", timestamp: Date.now() }] },
		await privateSideCall(model, options, role),
	);
	if (message.stopReason !== "stop") throw new Error(message.errorMessage ?? message.stopReason);
	return message;
}

describe("private side calls through Sprilicred", () => {
	for (const [family, api, role, reply] of [
		["anthropic", "anthropic-messages", "skill", anthropicReply],
		["openai", "openai-responses", "commit", responsesReply],
	] as const) {
		it(`${family}: sends the trigger once on a fresh session that never names the chat, then the call on it`, async () => {
			const model = gatewayModel(api, `sprilicred-${family}`);
			const wire = gateway(request => (isTrigger(request) ? reply("OK") : reply("Fresh title", 12)));
			await Promise.all([
				sideCall(model, chatScopedOptions(wire.fetch), role),
				sideCall(model, chatScopedOptions(wire.fetch), role),
			]);
			await sideCall(model, chatScopedOptions(wire.fetch), role);

			const session = privateSideSessionId(role);
			const [trigger, ...calls] = wire.requests;
			expect(isTrigger(trigger)).toBe(true);
			expect(calls).toHaveLength(3);
			expect(calls.some(isTrigger)).toBe(false);
			for (const request of wire.requests) {
				expect(request.headers.get(PRIVATE_SESSION_HEADER)).toBe(session);
				if (family === "anthropic") {
					expect(request.headers.get("x-claude-code-session-id")).toBe(session);
					const userId = (request.body.metadata as { user_id: string }).user_id;
					expect(JSON.parse(userId).session_id).toBe(session);
				}
			}
			// The trigger names no other session, so Sprilicred cannot mark the chat private:
			// the chat id travels only as the parent link, which Sprilicred never marks.
			expect(trigger.raw).not.toContain(CHAT_ID);
			expect(trigger.headers.get("x-omp-parent-session-id")).toBe(CHAT_ID);
			for (const [name, value] of trigger.headers) {
				if (name !== "x-omp-parent-session-id") expect(value).not.toContain(CHAT_ID);
			}
		});
	}

	it("leaves a call to any other provider untouched", async () => {
		const model = gatewayModel("anthropic-messages", "anthropic");
		const options = chatScopedOptions(gateway(() => anthropicReply("x")).fetch);
		expect(await privateSideCall(model, options, "title")).toBe(options);
	});

	it("does not send the side call when a model, not Sprilicred, answers the trigger", async () => {
		const model = gatewayModel("anthropic-messages", "sprilicred-anthropic");
		const wire = gateway(() => anthropicReply("OK", 9));
		await expect(sideCall(model, chatScopedOptions(wire.fetch), "label")).rejects.toThrow(
			"Sprilicred did not confirm a private side session",
		);
		// The failed trigger is not re-sent at once, and nothing else is sent either.
		await expect(sideCall(model, chatScopedOptions(wire.fetch), "label")).rejects.toThrow();
		expect(wire.requests).toHaveLength(1);
	});

	it("keeps one caller's abort from failing another caller waiting on the same trigger", async () => {
		const model = gatewayModel("anthropic-messages", "sprilicred-anthropic");
		const release = Promise.withResolvers<void>();
		const wire = gateway(request => (isTrigger(request) ? anthropicReply("OK") : anthropicReply("Fresh title", 12)));
		const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (wire.requests.length === 0) await release.promise;
			return wire.fetch(input, init);
		}) as typeof globalThis.fetch;
		const abort = new AbortController();
		const first = sideCall(model, { ...chatScopedOptions(slowFetch), signal: abort.signal }, "summary");
		const second = sideCall(model, chatScopedOptions(slowFetch), "summary");
		abort.abort(new Error("title superseded"));
		release.resolve();
		await expect(first).rejects.toThrow("title superseded");
		expect((await second).content).toEqual([{ type: "text", text: "Fresh title" }]);
		expect(wire.requests.filter(isTrigger)).toHaveLength(1);
	});
});
