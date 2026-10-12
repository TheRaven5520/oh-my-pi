import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Agreed Release55 wire contract, shared by /anthropic/v1/messages and /v1/responses.
const busyMessage = "Sprilicred busy: upstream capacity is briefly saturated; retry in 2 s";
const busyError = { type: "rate_limit_error", code: "rate_limited", message: busyMessage, retry_after: 2 };
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
const anthropic = getBundledModel("anthropic", "claude-haiku-4-5-20251001") as Model<"anthropic-messages">;
const openai = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function expectBusy(result: AssistantMessage) {
	expect(result.stopReason).toBe("error");
	expect(result.errorStatus).toBe(429);
	expect(AIError.retriable(result.errorId)).toBe(true);
	expect(AIError.is(result.errorId, AIError.Flag.UsageLimit)).toBe(false);
	expect(extractProviderRetryHint(result.provider, result.errorMessage)).toBe(2000);
}

describe("Sprilicred busy response", () => {
	for (const api of ["anthropic-messages", "openai-responses"] as const) {
		it(`${api} parses the agreed body without headers as a transient delay`, () => {
			const text = `429 ${JSON.stringify({ type: "error", error: busyError })}`;
			const result: AssistantMessage = {
				role: "assistant", api, provider: api === "anthropic-messages" ? "sprilicred-anthropic" : "sprilicred-openai",
				model: "test", content: [], stopReason: "error", timestamp: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				errorStatus: 429, errorMessage: text,
			};
			AIError.classifyMessage(result);
			expectBusy(result);
		});
		for (const header of ["retry-after", "retry-after-ms"]) {
			it(`${api} retains ${header} when the body has no delay`, async () => {
				const customFetch: FetchImpl = Object.assign(async () => new Response(JSON.stringify({
					type: "error", error: { type: "rate_limit_error", code: "rate_limited", message: "Sprilicred busy" },
				}), { status: 429, headers: { "content-type": "application/json", [header]: header === "retry-after" ? "2" : "2000" } }),
				{ preconnect: fetch.preconnect });
				const options = { apiKey: "test-key", fetch: customFetch, maxRetryDelayMs: 500 };
				const result = await (api === "anthropic-messages"
					? streamAnthropic(anthropic, context, options)
					: streamOpenAIResponses(openai, context, options)).result();
				expectBusy(result);
			}, 30_000);
		}
	}
	it("in-band Responses error frame retains header-only timing through finalization", async () => {
		const output: AssistantMessage = {
			role: "assistant", api: openai.api, provider: openai.provider, model: openai.id,
			content: [], stopReason: "stop", timestamp: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		// Gateway frames extend the standard Responses event schema with status/headers.
		async function* events(): AsyncIterable<never> {
			yield { type: "error", status: 429, error: { ...busyError, message: "Sprilicred busy" },
				headers: { "retry-after": "2", "retry-after-ms": "2000" } } as never;
		}
		try {
			await processResponsesStream(events(), output, new AssistantMessageEventStream(), openai);
			throw new Error("Expected busy error");
		} catch (error) {
			const finalized = await AIError.finalize(error, { api: openai.api, provider: openai.provider });
			Object.assign(output, { stopReason: finalized.stopReason, errorStatus: finalized.status,
				errorId: finalized.id, errorMessage: finalized.message });
			expectBusy(output);
		}
	});
});
