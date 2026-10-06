/**
 * The one-line notice that tells the person what became of a turn that asked
 * for fast or ultrafast, read from the turn's `AssistantMessage.speed`
 * (Sprilicred's speed headers, else the provider's own report). Sprilicred
 * never refuses a faster tier: ultrafast it can't run goes at fast (when fast
 * is allowed) or standard, fast at standard, and the reason header says why.
 * A turn refused outright (a 400 `ultrafast_*`, from a Sprilicred that
 * refused Ultrafast) says why in the same words as the Sprilicred omp extension.
 */
import type { AssistantMessage, RequestedSpeed } from "@oh-my-pi/pi-ai";

export interface SpeedNotice {
	/** Identity of the outcome; a notice repeats only when this changes. */
	key: string;
	level: "info" | "warning";
	text: string;
	/** Shown even when the outcome has not changed (a refused turn). */
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
 * What Sprilicred refusing an Ultrafast turn says, by reason. Identical in the
 * Sprilicred omp extension (deploy/omp-extension/sprilicred.ts).
 */
export function ultrafastRefusalText(reason: string | undefined): string {
	switch (reason) {
		case "not_permitted":
			return "Ultrafast isn't enabled for you. Ask an admin, or use /fast.";
		case "no_pro500_capacity":
			return "Ultrafast unavailable: no Pro 500 account has room right now. Use /fast.";
		case "model_unsupported":
			return "Ultrafast isn't available on this model. Use /fast.";
		case "account_refuses":
			return "Ultrafast refused by the serving account. Use /fast.";
		default:
			return `Ultrafast refused (${reason ? `reason ${reason}` : "Sprilicred gave no reason"}). Use /fast.`;
	}
}

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
					? `Ultrafast not sent: ${modelLabel} doesn't offer Ultrafast.`
					: `Fast mode not sent: ${modelLabel} has no fast mode here.`,
			always: false,
		};
	}
	const name = speed.requested === "ultrafast" ? "Ultrafast" : "Fast mode";
	const reason = speed.reason;
	const why = reason ? (REASON_TEXT[reason] ?? `reason ${reason}`) : undefined;
	if (speed.refused) {
		// Sprilicred refuses Ultrafast it can't run (and an older one refused fast, 409 `speed_refused`).
		return {
			key: `refused:${speed.requested}:${reason ?? ""}`,
			level: "warning",
			text:
				speed.requested === "ultrafast"
					? ultrafastRefusalText(reason)
					: `${name} refused: ${why ?? "Sprilicred gave no reason"}.`,
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

export type SpeedMode = "normal" | "fast" | "ultrafast";

/** The status line's speed label and how to colour it. Same words as the Sprilicred omp extension. */
export interface SpeedStatus {
	text: string;
	level: "dim" | "normal" | "warning";
}

const MODE_NAME: Readonly<Record<SpeedMode, string>> = { normal: "Normal", fast: "Fast", ultrafast: "Ultrafast" };

/**
 * What the status line says for the selected mode and, when Sprilicred
 * reported on the last turn in that mode, what it served: "Fast" as asked,
 * "Ultrafast→Fast" / "Fast→Normal" served slower, "Ultrafast refused" for a
 * turn that failed with Sprilicred's refusal. `served` is the tier served, or "refused". Identical in
 * the Sprilicred omp extension (deploy/omp-extension/sprilicred.ts).
 */
export function speedStatus(selected: SpeedMode, served?: SpeedMode | "refused"): SpeedStatus {
	if (selected === "normal") return { text: MODE_NAME.normal, level: "dim" };
	if (served === undefined || served === selected) return { text: MODE_NAME[selected], level: "normal" };
	if (served === "refused") return { text: `${MODE_NAME[selected]} refused`, level: "warning" };
	return { text: `${MODE_NAME[selected]}→${MODE_NAME[served]}`, level: "warning" };
}

/**
 * What Sprilicred served of `mode` on this turn, or `undefined` when the turn
 * says nothing about it (asked for another tier, failed for another reason,
 * or no Sprilicred report).
 */
export function servedSpeed(message: AssistantMessage, mode: SpeedMode): SpeedMode | "refused" | undefined {
	const speed = message.speed;
	if (!speed || speed.requested !== mode) return undefined;
	if (speed.refused) return "refused";
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const served = speed.served ?? speed.forwarded;
	return served === "standard" ? "normal" : served;
}
