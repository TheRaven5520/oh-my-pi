import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, ModelSpec, ServiceTier } from "@oh-my-pi/pi-ai/types";
import { coerceServiceTierByFamily } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mockFetch } from "./helpers/fetch-mock";

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function openaiModel(provider: string): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-6-astra",
		name: "gpt-6-astra",
		api: "openai-responses",
		provider,
		baseUrl: "https://gateway.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	} as ModelSpec<"openai-responses">);
}

const SPEED = (requested: string, forwarded: string, reason: string) => ({
	"x-sprilicred-speed-requested": requested,
	"x-sprilicred-speed": forwarded,
	"x-sprilicred-speed-reason": reason,
});

function sse(events: unknown[], headers: Record<string, string> = {}): Response {
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

/** A one-word answer, so the provider takes the turn as a real completion. */
const TEXT = [
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{
		type: "response.content_part.added",
		item_id: "msg_1",
		output_index: 0,
		content_index: 0,
		part: { type: "output_text", text: "", annotations: [] },
	},
	{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
	{
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok", annotations: [] }],
		},
	},
];

const completed = (serviceTier?: string) => ({
	type: "response.completed",
	response: {
		status: "completed",
		...(serviceTier ? { service_tier: serviceTier } : {}),
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
	},
});

async function runResponses(model: Model<"openai-responses">, serviceTier: ServiceTier, reply: () => Response) {
	let body: Record<string, unknown> = {};
	const fetch = mockFetch(async (_input, init) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return reply();
	});
	const message = await streamOpenAIResponses(model, CONTEXT, { apiKey: "k", fetch, serviceTier }).result();
	return { body, message };
}

describe("ultrafast on the wire", () => {
	it("sends service_tier=ultrafast through a Sprilicred OpenAI provider", async () => {
		const { body, message } = await runResponses(openaiModel("sprilicred-openai"), "ultrafast", () =>
			sse([...TEXT, completed("ultrafast")], SPEED("ultrafast", "ultrafast", "forwarded")),
		);
		expect(body.service_tier).toBe("ultrafast");
		expect(message.speed).toEqual({
			requested: "ultrafast",
			forwarded: "ultrafast",
			reason: "forwarded",
			served: "ultrafast",
		});
	});

	it("omits ultrafast for any other OpenAI-family provider and records no speed", async () => {
		const { body, message } = await runResponses(openaiModel("personal-openai"), "ultrafast", () =>
			sse([...TEXT, completed()]),
		);
		expect(body.service_tier).toBeUndefined();
		expect(message.speed).toBeUndefined();
	});

	it("keeps ultrafast across a session save and reload only for the OpenAI family", () => {
		expect(coerceServiceTierByFamily(JSON.parse(JSON.stringify({ openai: "ultrafast" })))).toEqual({
			openai: "ultrafast",
		});
		expect(coerceServiceTierByFamily({ anthropic: "ultrafast", google: "ultrafast" })).toBeUndefined();
	});
});

describe("speed outcome from Sprilicred's headers and errors (OpenAI Responses)", () => {
	it("reads a fast request downgraded to standard, with its reason", async () => {
		const { body, message } = await runResponses(openaiModel("sprilicred-openai"), "priority", () =>
			sse([...TEXT, completed("default")], SPEED("fast", "standard", "api_fallback_refused")),
		);
		expect(body.service_tier).toBe("priority");
		expect(message.speed).toEqual({
			requested: "fast",
			forwarded: "standard",
			reason: "api_fallback_refused",
			served: "standard",
		});
	});

	it("reads ultrafast that Sprilicred fell back to fast, with its reason", async () => {
		const { body, message } = await runResponses(openaiModel("sprilicred-openai"), "ultrafast", () =>
			sse([...TEXT, completed("priority")], SPEED("ultrafast", "fast", "no_pro500_capacity")),
		);
		expect(body.service_tier).toBe("ultrafast");
		expect(message.speed).toEqual({
			requested: "ultrafast",
			forwarded: "fast",
			reason: "no_pro500_capacity",
			served: "fast",
		});
	});

	it("keeps the provider's lower echo beside what the gateway forwarded", async () => {
		const { message } = await runResponses(openaiModel("sprilicred-openai"), "ultrafast", () =>
			sse([...TEXT, completed("priority")], SPEED("ultrafast", "ultrafast", "forwarded")),
		);
		expect(message.speed?.forwarded).toBe("ultrafast");
		expect(message.speed?.served).toBe("fast");
	});

	it("keeps Sprilicred fast when Codex echoes its default tier", async () => {
		const { message } = await runResponses(openaiModel("sprilicred-openai"), "priority", () =>
			sse([...TEXT, completed("default")], SPEED("fast", "fast", "forwarded")),
		);
		expect(message.speed).toMatchObject({ requested: "fast", forwarded: "fast", served: "fast" });
	});

	it("falls back to the provider's echo when no speed headers come back", async () => {
		const { message } = await runResponses(openaiModel("sprilicred-openai"), "priority", () =>
			sse([...TEXT, completed("default")]),
		);
		expect(message.speed).toEqual({ requested: "fast", served: "standard" });
	});

	it("marks an older server's 409 speed_refused as refused with the header reason", async () => {
		const { message } = await runResponses(
			openaiModel("sprilicred-openai"),
			"ultrafast",
			() =>
				new Response(
					JSON.stringify({
						error: { code: "speed_refused", message: "No Pro 500 account has room for Ultrafast right now." },
					}),
					{
						status: 409,
						headers: {
							"content-type": "application/json",
							...SPEED("ultrafast", "standard", "no_pro500_capacity"),
						},
					},
				),
		);
		expect(message.stopReason).toBe("error");
		expect(message.speed).toEqual({
			requested: "ultrafast",
			forwarded: "standard",
			reason: "no_pro500_capacity",
			refused: true,
		});
	});

	it("marks Sprilicred's 400 Ultrafast refusal as refused with its reason", async () => {
		const { message } = await runResponses(
			openaiModel("sprilicred-openai"),
			"ultrafast",
			() =>
				new Response(
					JSON.stringify({
						error: {
							type: "ultrafast_unavailable",
							code: "ultrafast_unavailable",
							message: "Ultrafast unavailable: no Pro 500 account has room right now. Use /fast.",
							param: null,
						},
					}),
					{
						status: 400,
						headers: {
							"content-type": "application/json",
							...SPEED("ultrafast", "standard", "no_pro500_capacity"),
						},
					},
				),
		);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("no Pro 500 account has room right now");
		expect(message.speed).toEqual({
			requested: "ultrafast",
			forwarded: "standard",
			reason: "no_pro500_capacity",
			refused: true,
		});
	});

	it("reads the speed fields of a WebSocket-style error frame", async () => {
		const { message } = await runResponses(openaiModel("sprilicred-openai"), "ultrafast", () =>
			sse([
				{
					type: "error",
					error: {
						type: "speed_refused",
						message: "Ultrafast is turned off for you.",
						status: 409,
						speed_requested: "ultrafast",
						speed: "standard",
						speed_reason: "not_permitted",
					},
				},
			]),
		);
		expect(message.speed).toEqual({
			requested: "ultrafast",
			forwarded: "standard",
			reason: "not_permitted",
			refused: true,
		});
	});

	it("does not report Ultrafast served when the upstream refuses the tier mid-stream", async () => {
		const { message } = await runResponses(openaiModel("sprilicred-openai"), "ultrafast", () =>
			sse(
				[
					{
						type: "response.failed",
						response: {
							status: "failed",
							error: { code: "invalid_request_error", message: "Unsupported service_tier: ultrafast" },
						},
					},
				],
				SPEED("ultrafast", "ultrafast", "forwarded"),
			),
		);
		expect(message.stopReason).toBe("error");
		expect(message.speed).toEqual({
			requested: "ultrafast",
			forwarded: "ultrafast",
			reason: "account_refuses",
			refused: true,
		});
	});

	it("leaves an unrelated failure after a forwarded tier unrefused", async () => {
		const { message } = await runResponses(openaiModel("sprilicred-openai"), "ultrafast", () =>
			sse(
				[
					{
						type: "response.failed",
						response: { status: "failed", error: { code: "server_error", message: "upstream hiccup" } },
					},
				],
				SPEED("ultrafast", "ultrafast", "forwarded"),
			),
		);
		expect(message.speed?.refused).toBeUndefined();
	});
});

describe("speed outcome on Anthropic fast mode", () => {
	const model = buildModel({
		id: "claude-opus-5-5",
		name: "claude-opus-5-5",
		api: "anthropic-messages",
		provider: "sprilicred-anthropic",
		baseUrl: "https://gateway.example/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: { supportsFastMode: true },
	} as ModelSpec<"anthropic-messages">);

	function anthropicSse(usageSpeed: string | undefined, headers: Record<string, string>): Response {
		const usage = { input_tokens: 1, output_tokens: 1, ...(usageSpeed ? { speed: usageSpeed } : {}) };
		const events = [
			{
				type: "message_start",
				message: { id: "msg_1", type: "message", role: "assistant", content: [], model: model.id, usage },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
			{ type: "message_stop" },
		];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream", ...headers },
		});
	}

	async function run(reply: () => Response) {
		const fetch = mockFetch(async () => reply());
		return streamAnthropic(model, CONTEXT, {
			apiKey: "sk-spr-test",
			isOAuth: true,
			serviceTier: "priority",
			fetch,
		}).result();
	}

	it("reads the gateway's forwarded fast and the provider's usage.speed", async () => {
		const message = await run(() => anthropicSse("fast", SPEED("fast", "fast", "forwarded")));
		expect(message.speed).toEqual({ requested: "fast", forwarded: "fast", reason: "forwarded", served: "fast" });
	});

	it("falls back to usage.speed without speed headers", async () => {
		const message = await run(() => anthropicSse("standard", {}));
		expect(message.speed).toEqual({ requested: "fast", served: "standard" });
	});

	it("reads a downgrade reason on a subscription account", async () => {
		const message = await run(() => anthropicSse(undefined, SPEED("fast", "standard", "subscription_extra_usage")));
		expect(message.speed).toEqual({ requested: "fast", forwarded: "standard", reason: "subscription_extra_usage" });
	});

	it("marks a 409 refusal from the error response's headers", async () => {
		const message = await run(
			() =>
				new Response(
					JSON.stringify({ type: "error", error: { type: "speed_refused", message: "Fast mode refused." } }),
					{
						status: 409,
						headers: { "content-type": "application/json", ...SPEED("fast", "standard", "not_permitted") },
					},
				),
		);
		expect(message.stopReason).toBe("error");
		expect(message.speed).toEqual({
			requested: "fast",
			forwarded: "standard",
			reason: "not_permitted",
			refused: true,
		});
	});
});
