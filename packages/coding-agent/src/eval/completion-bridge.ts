/**
 * Host-side handler for the eval `completion()` helper.
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_COMPLETION_BRIDGE_NAME} lets a single host handler serve both
 * transports without registering an agent-visible tool: cell code calls
 * `completion(prompt, opts)`, the prelude forwards `{ prompt, model, system?, schema? }`
 * through the bridge, and this module performs one stateless completion.
 *
 * The call is oneshot and toolless from the model's perspective — pure text
 * in, text (or, with `schema`, a structured object) out.
 */

import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { privateSideCall } from "../session/private-side-calls";
import { buildSideAgentHeaders } from "../session/side-agent-headers";
import { Semaphore } from "../task/parallel";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `completion()` helper across both runtimes. */
export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

/** Synthetic tool the model is forced to call when a `schema` is supplied. */
const STRUCTURED_TOOL_NAME = "respond";

type CompletionTier = "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<CompletionTier, string> = {
	smol: "@smol",
	default: "@default",
	slow: "@slow",
};

const completionArgsSchema = type({
	prompt: "string>0",
	"model?": "'smol'|'default'|'slow'",
	"system?": "string",
	"schema?": { "[string]": "unknown" },
});

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Terminal payload of a retained handle. */
export interface EvalCompletionResult {
	text: string;
	/** Structured payload; when present the cell receives it in place of `text`. */
	data?: unknown;
	details: { model: string; tier?: CompletionTier; structured: boolean };
}

/** Handle returned immediately after an eval completion starts. */
export interface EvalCompletionHandleResult {
	id: string;
}

/** Process-local state retained for one eval completion handle. */
export interface CompletionHandleEntry {
	ownerId: string;
	controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	result?: EvalCompletionResult;
	error?: string;
	evictionTimer?: NodeJS.Timeout;
}

const COMPLETION_HANDLE_RETENTION_MS = 30 * 60 * 1000;
const completionHandles = new Map<string, CompletionHandleEntry>();

/**
 * Process-wide ceiling on eval model requests executing at once, shared by
 * `completion()` handles, `judge()`, and `judge_batch()` items. A cell that
 * fans out hundreds of calls otherwise opens every request simultaneously and
 * floods the provider (including self-hosted models that serve requests
 * serially). Queued handles
 * report `running` until admitted.
 */
export const EVAL_HANDLE_CONCURRENCY = 32;
export const evalRequestSlots = new Semaphore(EVAL_HANDLE_CONCURRENCY);

/** Resolve a retained completion handle by id. */
export function getCompletionHandle(id: string): CompletionHandleEntry | undefined {
	return completionHandles.get(id);
}

/** Cancel and remove every completion handle owned by an agent session. */
export function releaseCompletionHandles(ownerId: string): void {
	for (const [id, entry] of completionHandles) {
		if (entry.ownerId !== ownerId) continue;
		entry.controller.abort(new ToolError("Completion handle owner released"));
		clearTimeout(entry.evictionTimer);
		completionHandles.delete(id);
	}
}

interface CompletionCandidate {
	model: Model<Api>;
	reasoning: Effort | undefined;
	disableReasoning: boolean;
}

/**
 * Resolve a tier to its model. `default` prefers the session's active model
 * before the `@default` role.
 */
function resolveTierCandidate(tier: CompletionTier, session: ToolSession): CompletionCandidate | undefined {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return undefined;
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return undefined;

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		return resolveModelFromString(expandRoleAlias(pattern, session.settings), available, matchPreferences);
	};
	const model =
		tier === "default"
			? (resolve(session.getActiveModelString?.() ?? session.getModelString?.()) ?? resolve(TIER_TO_PATTERN.default))
			: resolve(TIER_TO_PATTERN[tier]);
	if (!model) return undefined;
	return {
		model,
		reasoning: clampThinkingLevelForModel(model, reasoningForTier(tier, model)),
		disableReasoning: false,
	};
}

/**
 * Choose the reasoning effort for a tier. Only `slow` opts into thinking, and
 * only on reasoning-capable models — guarding against `requireSupportedEffort`
 * throwing downstream on models that cannot reason. Clamps to the highest
 * supported effort so a reasoning model without `high` does not 400.
 */
function reasoningForTier(tier: CompletionTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

async function executeCompletion(
	prompt: string,
	finalTier: CompletionTier,
	system: string | undefined,
	schema: Record<string, unknown> | undefined,
	candidate: CompletionCandidate,
	session: ToolSession,
	signal: AbortSignal,
): Promise<EvalCompletionResult> {
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("completion() has no model registry.");

	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: schema,
					strict: false,
				},
			]
		: undefined;
	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	// The completion runs with no provider session id; link it to the chat.
	const headers = buildSideAgentHeaders(
		session.getProviderSessionId?.() ?? session.getSessionId?.() ?? undefined,
		"helper",
	);
	const systemPrompt = system ? [system] : ["You are a helpful assistant."];
	const model = candidate.model;
	// Forward the session id so session-sticky OAuth credentials resolve (see #5325).
	const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined, { signal });
	if (!apiKey) {
		throw new ToolError(
			`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
		);
	}
	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			tools,
		},
		await privateSideCall(
			model,
			{
				apiKey: registry.resolver(model, session.getSessionId?.() ?? undefined),
				signal,
				reasoning: candidate.reasoning,
				disableReasoning: candidate.disableReasoning,
				toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
				headers,
			},
			"helper",
		),
		{ telemetry, oneshotKind: "eval_completion" },
	);
	if (response.stopReason === "aborted") {
		throw new ToolError("completion() request aborted.");
	}
	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "completion() request failed.");
	}

	let resultText: string;
	if (schema) {
		const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
		let value: unknown;
		if (call) {
			value = call.arguments;
		} else {
			const text = extractTextContent(response);
			if (!text) throw new ToolError("completion() returned no structured response.");
			try {
				value = parseJsonPayload(text);
			} catch {
				throw new ToolError("completion() did not return a structured response matching the schema.");
			}
		}
		resultText = JSON.stringify(value);
	} else {
		resultText = extractTextContent(response);
		if (!resultText) throw new ToolError("completion() returned no text output.");
	}

	return {
		text: resultText,
		details: { model: formatModelString(model), tier: finalTier, structured: Boolean(schema) },
	};
}

/** Start a stateless completion and return its process-local handle immediately. */
export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionHandleResult> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, model: modelTier, system, schema } = parsed;
	const finalTier: CompletionTier = modelTier ?? "default";
	const candidate = resolveTierCandidate(finalTier, options.session);
	if (!candidate) {
		throw new ToolError(
			`completion() could not resolve a model for the "${finalTier}" tier. Configure modelRoles.${finalTier === "default" ? "default" : finalTier} or ensure a provider is available.`,
		);
	}

	return retainCompletionHandle("cmp", options, signal =>
		executeCompletion(prompt, finalTier, system, schema, candidate, options.session, signal),
	);
}

/**
 * Run `execute` in the background under a session-owned, cancellable handle
 * and return its id immediately; `wait()`/`status()`/`cancel()` resolve it
 * through {@link getCompletionHandle}. Settled entries are evicted after
 * {@link COMPLETION_HANDLE_RETENTION_MS}.
 */
export function retainCompletionHandle(
	prefix: string,
	options: EvalCompletionBridgeOptions,
	execute: (signal: AbortSignal) => Promise<EvalCompletionResult>,
): EvalCompletionHandleResult {
	const id = `${prefix}-${Snowflake.next()}`;
	const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const entry: CompletionHandleEntry = {
		ownerId,
		controller,
		promise: Promise.resolve(),
		settled: false,
	};
	completionHandles.set(id, entry);
	const run = async (): Promise<EvalCompletionResult> => {
		await evalRequestSlots.acquire(signal);
		try {
			return await execute(signal);
		} finally {
			evalRequestSlots.release();
		}
	};
	entry.promise = run()
		.then(
			result => {
				entry.result = result;
			},
			error => {
				entry.error = error instanceof Error ? error.message : String(error);
			},
		)
		.finally(() => {
			entry.settled = true;
			const timer = setTimeout(() => {
				if (completionHandles.get(id) === entry) completionHandles.delete(id);
			}, COMPLETION_HANDLE_RETENTION_MS);
			timer.unref?.();
			entry.evictionTimer = timer;
		});
	return { id };
}
