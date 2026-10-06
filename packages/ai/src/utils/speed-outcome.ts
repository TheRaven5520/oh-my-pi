/**
 * What became of a request that asked for a faster serving tier.
 *
 * Sprilicred answers every request that asked for fast or ultrafast with
 * `x-sprilicred-speed-requested` (what was asked), `x-sprilicred-speed` (the
 * tier it forwarded upstream: `fast`/`ultrafast`/`standard`) and
 * `x-sprilicred-speed-reason` (`forwarded`, `not_permitted`, …), on errors
 * Fast it can't run falls back to standard; Ultrafast falls back to fast,
 * then standard. A 400 `ultrafast_*` is an outright refusal; an older server
 * refused fast too (HTTP 409 `speed_refused`). Over WebSocket
 * the same values ride inside the error frame's error object as
 * `speed_requested` / `speed` / `speed_reason`. What the provider then served
 * comes from its own report: OpenAI's echoed `service_tier`, Anthropic's
 * `usage.speed`; that is all there is from another provider or an older server.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AssistantMessage, RequestedSpeed, SpeedOutcome } from "../types";

export const SPEED_REQUESTED_HEADER = "x-sprilicred-speed-requested";
export const SPEED_FORWARDED_HEADER = "x-sprilicred-speed";
export const SPEED_REASON_HEADER = "x-sprilicred-speed-reason";

/**
 * Error codes that refuse the faster tier itself, with the reason each
 * implies when no speed header or field names one. `speed_refused` always
 * carries its reason; the others are Sprilicred's Ultrafast refusals.
 */
const REFUSAL_CODE_REASONS: Readonly<Record<string, string | undefined>> = {
	speed_refused: undefined,
	ultrafast_not_allowed: "not_permitted",
	ultrafast_unsupported_model: "model_unsupported",
	ultrafast_unavailable: "no_pro500_capacity",
	ultrafast_refused: "account_refuses",
};

type HeaderSource = Headers | Readonly<Record<string, string>> | undefined;
type Tier = NonNullable<SpeedOutcome["served"]>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
	if (!headers) return undefined;
	const value = headers instanceof Headers ? headers.get(name) : headers[name];
	return value?.trim() || undefined;
}

/** The faster tier a wire value names: OpenAI `priority`/`ultrafast`, Anthropic/Sprilicred `fast`. */
export function requestedSpeedForWire(value: unknown): RequestedSpeed | undefined {
	if (typeof value !== "string") return undefined;
	switch (value.trim().toLowerCase()) {
		case "fast":
		case "priority":
			return "fast";
		case "ultrafast":
			return "ultrafast";
		default:
			return undefined;
	}
}

function asTier(value: unknown): Tier | undefined {
	if (typeof value !== "string") return undefined;
	const tier = value.trim().toLowerCase();
	if (tier === "standard" || tier === "default" || tier === "auto" || tier === "flex" || tier === "scale") {
		return "standard";
	}
	return requestedSpeedForWire(tier);
}

function refusalCode(value: unknown): string | undefined {
	return typeof value === "string" && Object.hasOwn(REFUSAL_CODE_REASONS, value) ? value : undefined;
}

/**
 * Sprilicred's speed headers, or `undefined` when the response carries none.
 * `requested` is what this request put on the wire; the header wins when set.
 */
export function speedOutcomeFromHeaders(
	headers: HeaderSource,
	requested: RequestedSpeed | undefined,
): SpeedOutcome | undefined {
	const asked = requestedSpeedForWire(readHeader(headers, SPEED_REQUESTED_HEADER)) ?? requested;
	const forwarded = asTier(readHeader(headers, SPEED_FORWARDED_HEADER));
	const reason = readHeader(headers, SPEED_REASON_HEADER)?.toLowerCase();
	if (!asked || (forwarded === undefined && reason === undefined)) return undefined;
	return { requested: asked, forwarded, reason };
}

/**
 * Speed fields in an error object (an HTTP error body, or a WebSocket/SSE
 * error frame, either bare or under `error`): `speed_requested`, `speed`,
 * `speed_reason`, the refusal code (`code`, or `type` as Sprilicred's
 * WebSocket error frames name it) and `status`.
 */
export function speedOutcomeFromErrorObject(
	value: unknown,
	requested: RequestedSpeed | undefined,
): SpeedOutcome | undefined {
	if (!isRecord(value)) return undefined;
	const inner = isRecord(value.error) ? value.error : value;
	const asked = requestedSpeedForWire(inner.speed_requested) ?? requested;
	if (!asked) return undefined;
	const forwarded = asTier(inner.speed);
	const code = refusalCode(inner.code) ?? refusalCode(inner.type);
	const speedReason = typeof inner.speed_reason === "string" ? inner.speed_reason.trim().toLowerCase() : "";
	const reason = speedReason || (code ? REFUSAL_CODE_REASONS[code] : undefined);
	if (forwarded === undefined && reason === undefined && !code) return undefined;
	const refused = code !== undefined || (inner.status === 409 && forwarded !== undefined);
	return { requested: asked, forwarded, reason, ...(refused ? { refused: true } : {}) };
}

/**
 * What a mid-stream `error` / `response.failed` event says about the faster
 * tier: its speed fields when it carries them (Sprilicred over WebSocket);
 * else, for an Ultrafast request the gateway forwarded, whether the upstream
 * error refused the tier itself (its error names `service_tier` or Ultrafast,
 * the test Sprilicred applies), in which case the turn was not served at
 * Ultrafast. Otherwise `prior` stands.
 */
export function speedOutcomeFromStreamError(event: unknown, prior: SpeedOutcome | undefined): SpeedOutcome | undefined {
	const fromFields = speedOutcomeFromErrorObject(event, prior?.requested);
	if (fromFields) return fromFields;
	if (prior?.requested !== "ultrafast" || prior.forwarded !== "ultrafast") return prior;
	const error = isRecord(event)
		? (event.error ?? (isRecord(event.response) ? event.response.error : undefined))
		: event;
	const said = (JSON.stringify(error ?? null) ?? "").toLowerCase();
	if (!said.includes("service_tier") && !said.includes("ultrafast")) return prior;
	return { requested: "ultrafast", forwarded: "ultrafast", reason: "account_refuses", refused: true };
}

/**
 * What a failed request's error says about its faster tier: Sprilicred's
 * speed headers on the HTTP error, the speed fields of its error body, and
 * whether the error refused the tier itself (409 `speed_refused`, or an older
 * Ultrafast refusal code). Walks the `cause` chain; falls back to `prior`
 * (what the request asked, or what a mid-stream error already recorded).
 */
export function speedOutcomeFromError(error: unknown, prior: SpeedOutcome | undefined): SpeedOutcome | undefined {
	const requested = prior?.requested;
	let current: unknown = error;
	for (let depth = 0; depth < 5 && isRecord(current); depth++) {
		const captured = isRecord(current.captured) ? current.captured : undefined;
		const headers =
			current.headers instanceof Headers
				? current.headers
				: captured?.headers instanceof Headers
					? captured.headers
					: undefined;
		const fromHeaders = speedOutcomeFromHeaders(headers, requested);
		const asked = fromHeaders?.requested ?? requested;
		const fromBody =
			speedOutcomeFromErrorObject(captured?.bodyJson, asked) ?? speedOutcomeFromErrorObject(current.error, asked);
		const code = refusalCode(current.code);
		const outcomeAsked = fromHeaders?.requested ?? fromBody?.requested ?? requested;
		if (outcomeAsked && (fromHeaders || fromBody || code)) {
			const refused =
				code !== undefined || fromBody?.refused === true || (current.status === 409 && fromHeaders !== undefined);
			const outcome: SpeedOutcome = {
				requested: outcomeAsked,
				forwarded: fromHeaders?.forwarded ?? fromBody?.forwarded,
				reason: fromHeaders?.reason ?? fromBody?.reason ?? (code ? REFUSAL_CODE_REASONS[code] : undefined),
			};
			if (refused) outcome.refused = true;
			return outcome;
		}
		current = current.cause;
	}
	return prior;
}

/**
 * Record what the provider reported serving (OpenAI's echoed `service_tier`,
 * Anthropic's `usage.speed`). It can be lower than what the gateway forwarded,
 * so it is kept alongside, never in place of, the forwarded tier.
 */
export function applyProviderReportedSpeed(output: Pick<AssistantMessage, "speed">, reported: unknown): void {
	const echoed = typeof reported === "string" ? reported.trim().toLowerCase() : undefined;
	// Codex echoes `default`/`auto` for a request Sprilicred forwarded at fast;
	// that echo names the provider default, not the gateway tier actually served.
	if (output.speed?.forwarded !== undefined && (echoed === "default" || echoed === "auto")) {
		output.speed.served = output.speed.forwarded;
		return;
	}
	const served = asTier(reported);
	if (output.speed && served !== undefined) output.speed.served = served;
}
