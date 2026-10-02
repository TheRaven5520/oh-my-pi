/**
 * Sprilicred private mode for omp's own one-shot side calls.
 *
 * Sprilicred answers a request whose latest user message is exactly
 * `` `private` `` with "OK" itself, never reaching a provider, and keeps no
 * record of that provider session from then on: no Activity row and no chat
 * (its cost still counts in running totals). omp's background one-shot calls
 * (skill-hint compression, session titles and labels, memory extraction,
 * commit messages, …) otherwise each show up as a chat and an Activity row of
 * their own.
 *
 * {@link privateSideCall} moves such a call onto a side session of its own,
 * one per role per process, sends the trigger on that session once, and
 * returns the call's options naming it. Only `sprilicred-*` providers get
 * this: any other provider would send the word to a real model.
 *
 * Nothing the trigger sends names the chat the call serves, so it can never
 * make the person's own chat private: the session id is fresh, Sprilicred's
 * `x-session-id` header names it, and `metadata.user_id` (which can carry the
 * chat's session id) is dropped so the Anthropic transport derives it from the
 * fresh id. The call itself is sent the same way. `x-omp-parent-session-id`
 * still links it to its chat.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, completeSimple, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { SideAgentRole } from "./side-agent-headers";

/** Exact text that makes a Sprilicred session private. */
export const PRIVATE_CHAT_TRIGGER = "`private`";
/** Sprilicred's own answer to {@link PRIVATE_CHAT_TRIGGER}. */
export const PRIVATE_CHAT_ACK = "OK";
/** Session header Sprilicred names a request's session by, ahead of the prompt-cache key and metadata. */
export const PRIVATE_SESSION_HEADER = "x-session-id";

/** Kinds of one-shot side call; each gets its own private session per process. */
export type PrivateSideRole = SideAgentRole | "skill" | "commit" | "recap";

/** Sprilicred answers the trigger itself, without a provider; anything slower is a failure. */
const TRIGGER_TIMEOUT_MS = 15_000;
/** Sprilicred's own reply ids: `msg_` / `resp_` and 32 hex digits. */
const GATEWAY_REPLY_ID = /^(?:msg|resp)_[0-9a-f]{32}$/;
/** After a failed trigger, side calls on that session fail at once for this long instead of re-sending it. */
const TRIGGER_RETRY_MS = 60_000;

const sessionIds = new Map<PrivateSideRole, string>();
const triggers = new Map<string, Promise<void>>();

/** This process's private side session for `role`. */
export function privateSideSessionId(role: PrivateSideRole): string {
	let id = sessionIds.get(role);
	if (!id) {
		id = Bun.randomUUIDv7();
		sessionIds.set(role, id);
	}
	return id;
}

function withoutUserId(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!metadata || !("user_id" in metadata)) return metadata;
	const { user_id: _userId, ...rest } = metadata;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

function isGatewayAck(message: AssistantMessage): boolean {
	const text = message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
	const { input, output, cacheRead, cacheWrite } = message.usage;
	return (
		message.stopReason === "stop" &&
		text === PRIVATE_CHAT_ACK &&
		input + output + cacheRead + cacheWrite === 0 &&
		(message.responseId === undefined || GATEWAY_REPLY_ID.test(message.responseId))
	);
}

async function sendTrigger(model: Model<Api>, options: SimpleStreamOptions): Promise<void> {
	const reply = await completeSimple(
		model,
		{ messages: [{ role: "user", content: PRIVATE_CHAT_TRIGGER, timestamp: Date.now() }] },
		{
			apiKey: options.apiKey,
			sessionId: options.sessionId,
			headers: options.headers,
			metadata: options.metadata,
			maxTokens: 16,
			disableReasoning: true,
			// Shared by every call on the session, so no one caller's abort may cancel it.
			signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
			fetch: options.fetch,
		},
	);
	if (!isGatewayAck(reply)) {
		const text = reply.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		throw new Error(
			`Sprilicred did not confirm a private side session (${reply.stopReason}${reply.errorMessage ? `: ${reply.errorMessage}` : ""}${text ? `, replied ${JSON.stringify(text.slice(0, 80))}` : ""})`,
		);
	}
}

/**
 * Options for a side call that Sprilicred keeps no record of.
 *
 * For a `sprilicred-*` model, the call moves to `side.sessionId`, by default
 * this process's private side session for `role`, and the first call on that
 * session sends the trigger and waits for Sprilicred's own "OK"; concurrent
 * and later calls share that one trigger, each waiting only as long as its own
 * `signal` allows. If the trigger is not confirmed this throws, and the side
 * call must not be sent: sent anyway, it would be recorded. A failed trigger
 * is not re-sent for a minute. Any other provider gets `options` back
 * unchanged.
 *
 * `side.sessionId` must be the side agent's own fresh id, never one that
 * names the chat it serves.
 */
export async function privateSideCall<T extends SimpleStreamOptions>(
	model: Model<Api>,
	options: T,
	role: PrivateSideRole,
	side?: { sessionId: string },
): Promise<T> {
	// Only Sprilicred answers the trigger itself; anywhere else it is a real model call.
	if (!model.provider.startsWith("sprilicred-")) return options;
	const sessionId = side?.sessionId ?? privateSideSessionId(role);
	const privateOptions: T = {
		...options,
		sessionId,
		headers: { ...options.headers, [PRIVATE_SESSION_HEADER]: sessionId },
		metadata: withoutUserId(options.metadata),
	};
	const key = `${model.provider}\0${sessionId}`;
	let trigger = triggers.get(key);
	if (!trigger) {
		trigger = sendTrigger(model, privateOptions);
		triggers.set(key, trigger);
		trigger.catch(error => {
			logger.warn("Private side session not confirmed; its side calls are not sent", {
				provider: model.provider,
				role,
				error: String(error),
			});
			setTimeout(() => {
				if (triggers.get(key) === trigger) triggers.delete(key);
			}, TRIGGER_RETRY_MS).unref();
		});
	}
	const signal = options.signal;
	if (!signal) {
		await trigger;
		return privateOptions;
	}
	signal.throwIfAborted();
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([trigger, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	return privateOptions;
}

/**
 * Wrap a multi-request side agent's stream function (the auto-learn capture
 * turn) so every request runs privately on that agent's own session `sessionId`.
 */
export function wrapStreamFnPrivate(streamFn: StreamFn, role: PrivateSideRole, sessionId: string): StreamFn {
	return async (model, context, options) =>
		streamFn(model, context, await privateSideCall(model, options ?? {}, role, { sessionId }));
}
