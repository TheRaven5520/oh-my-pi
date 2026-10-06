/** Peer-message types and roster constants shared by messaging, `wait`, and child prompts. */

/** Maximum live peer rows embedded in child prompts. */
export const DEFAULT_PEER_ROSTER_LIMIT = 32;

/** Serializable peer message retained in coordination result snapshots. */
export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/**
	 * Automated wake-turn relay of a woken subagent's stop output (task executor
	 * `relayWakeTurnOutput`). Relays are answers, never wake sources: the
	 * recipient's own wake-turn relay must skip them or two idle peers
	 * ping-pong forever.
	 */
	wakeRelay?: boolean;
	/**
	 * Set by a `/fork` chat's `hand_back`: the body is the fork's report to the
	 * session that forked it. The recipient keeps its card on screen and is
	 * asked to tell the user the result; `done` marks the final report.
	 */
	forkReport?: ForkReport;
}

/** A `/fork` report's marker, copied into its `irc:incoming` record's details. */
export interface ForkReport {
	/** The fork's final report; the fork closes after the turn that sent it. */
	done: boolean;
}

/** The fork-report marker in an `irc:incoming` record's details, if it is one. */
export function forkReportOf(details: unknown): ForkReport | undefined {
	if (!details || typeof details !== "object") return undefined;
	const report = Reflect.get(details, "forkReport");
	if (!report || typeof report !== "object") return undefined;
	return { done: Reflect.get(report, "done") === true };
}

/** Delivery outcome for one peer recipient. */
export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}
/** Status ordering for peer rosters in child prompts. */
export const LIST_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };
