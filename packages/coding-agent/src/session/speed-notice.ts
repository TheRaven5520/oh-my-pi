/**
 * The one-line notice that tells the person what became of a turn that asked
 * for fast or ultrafast, read from the turn's `AssistantMessage.speed`
 * (Sprilicred's speed headers, else the provider's own report). Sprilicred
 * never refuses a faster tier: ultrafast it can't run goes at fast (when fast
 * is allowed) or standard, fast at standard, and the reason header says why.
 */
import type { AssistantMessage, RequestedSpeed } from "@oh-my-pi/pi-ai";

export interface SpeedNotice {
	/** Identity of the outcome; a notice repeats only when this changes. */
	key: string;
	level: "info" | "warning";
	text: string;
	/** Shown even when the outcome has not changed (a refused turn from an older Sprilicred). */
	always: boolean;
}

/** Why Sprilicred did not forward the tier asked for, by `x-sprilicred-speed-reason` code. */
const REASON_TEXT: Readonly<Record<string, string>> = {
	not_permitted: "not enabled for you",
	model_unsupported: "this model doesn't offer it",
	no_pro500_capacity: "no Pro 500 account has room",
	account_refuses: "the serving account refused it",
};

/**
 * Describe what became of this turn's faster tier, or `undefined` when there
 * is nothing to say: the turn asked for nothing faster, it failed for another
 * reason, or nobody reported what it was served at.
 *
 * `notSent` is a tier the session has on (`/fast`, `/ultrafast`) that the
 * turn's model cannot carry, so the request went without it; the notice says
 * so, naming `modelLabel`.
 */
export function describeSpeedOutcome(
	message: AssistantMessage,
	notSent: RequestedSpeed | undefined,
	modelLabel: string,
): SpeedNotice | undefined {
	const speed = message.speed;
	const finished = message.stopReason !== "error" && message.stopReason !== "aborted";
	if (!speed) {
		// The provider's own fast-mode fallback notice covers a dropped Anthropic `speed`.
		if (!notSent || !finished || message.disabledFeatures?.includes("priority")) return undefined;
		return {
			key: `omitted:${notSent}:${modelLabel}`,
			level: "info",
			text:
				notSent === "ultrafast"
					? `Ultrafast not sent: ${modelLabel} isn't a Sprilicred OpenAI model.`
					: `Fast mode not sent: ${modelLabel} has no fast mode here.`,
			always: false,
		};
	}
	const name = speed.requested === "ultrafast" ? "Ultrafast" : "Fast mode";
	const reason = speed.reason;
	const why = reason ? (REASON_TEXT[reason] ?? `reason ${reason}`) : undefined;
	if (speed.refused) {
		// Only an older Sprilicred refuses a turn over its tier (409 `speed_refused`).
		return {
			key: `refused:${speed.requested}:${reason ?? ""}`,
			level: "warning",
			text: `${name} refused: ${why ?? "Sprilicred gave no reason"}.`,
			always: true,
		};
	}
	if (!finished) return undefined;
	const served = speed.served ?? speed.forwarded;
	if (served === undefined) return undefined;
	if (served === speed.requested) {
		return {
			key: `served:${served}`,
			level: "info",
			text: speed.requested === "ultrafast" ? "Ultrafast mode on." : "Upgraded to fast mode.",
			always: false,
		};
	}
	// Sprilicred forwarded a slower tier than asked: say why, and what it used instead.
	if (speed.forwarded !== undefined && speed.forwarded !== speed.requested) {
		const using = speed.forwarded === "fast" ? "fast mode" : "standard";
		return {
			key: `downgraded:${speed.requested}:${speed.forwarded}:${reason ?? ""}`,
			level: "warning",
			text:
				reason === "api_fallback_refused"
					? `Refused fallback to API pricing; using ${using}.`
					: reason === "subscription_extra_usage"
						? `${name} unavailable on a subscription account (would bill API-priced extra usage); using ${using}.`
						: why
							? `${name} unavailable (${why}); using ${using}.`
							: `${name} unavailable; using ${using}.`,
			always: false,
		};
	}
	// Forwarded as asked (or no gateway in between), and the provider served it slower.
	const servedName = served === "fast" ? "fast" : "standard";
	return {
		key: `lower:${speed.requested}:${servedName}`,
		level: "warning",
		text: `${name} requested; served at ${servedName}.`,
		always: false,
	};
}
