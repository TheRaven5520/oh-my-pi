/**
 * Central `ageRefresh`: an external scheduler (the dotfiles age-refresh worker)
 * asks a chat to refresh because its process is old; the chat alone decides,
 * from its own settings and state, whether that happens now.
 */
import * as fs from "node:fs";
import type { CentralChatAge, CentralChatLastAgeRefresh } from "@oh-my-pi/pi-tui/apps/central/types";
import type { Settings } from "../config/settings";
import {
	cfgRefreshAgeEnabled,
	cfgRefreshAgeHardGraceSeconds,
	cfgRefreshAgeHardHours,
	cfgRefreshAgeSoftHours,
} from "../modes/settings";

/**
 * Epoch ms this process started: launch, `/refresh` (a new runtime process), or
 * `/restart` (exec resets the runtime's own uptime even when the PID is kept).
 * Derived from the runtime's uptime, never from a launcher or session timestamp.
 */
export const RUNTIME_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

export const AGE_REFRESH_MAX_BLOCKERS = 8;
export const AGE_REFRESH_MAX_BLOCKER_LENGTH = 64;

export type AgeRefreshDue = CentralChatAge["due"];
export type AgeRefreshOutcome = "refreshing" | "not-due" | "deferred" | "disabled" | "stale-runtime" | "blocked";

export interface AgeRefreshPolicy {
	enabled: boolean;
	/** 0: the idle tier is off. */
	softMs: number;
	/** 0: the forced tier is off. */
	hardMs: number;
	/** How long running work may finish once the forced tier is due. */
	hardGraceMs: number;
}

export interface CentralAgeRefreshRequest {
	sessionId: string;
	pid: number;
	startedAt: number;
	/** Conditions only the caller can see (e.g. tmux copy mode); any one defers the idle tier, none stops the forced one. */
	blockers: string[];
}

/** Work a forced refresh stopped or set aside; `kind` is an open set, worker logs it verbatim. */
export interface AgeRefreshInterrupted {
	kind: string;
	id: string;
	label: string;
	/** Last known state: elapsed time, last output line or status. */
	state?: string;
}

export interface CentralAgeRefreshResult {
	v: 1;
	outcome: AgeRefreshOutcome;
	trigger: "soft" | "hard" | null;
	reason: string;
	runtime: { pid: number; startedAt: number; ageMs: number };
	settings: AgeRefreshPolicy;
	interrupted: AgeRefreshInterrupted[];
}

/** Kinds of running work the forced tier waits for and then stops; the rest are modes, views and kept state. */
export const STOPPED_WORK_KINDS: Record<string, true> = {
	turn: true,
	tool: true,
	bash: true,
	eval: true,
	job: true,
	subagent: true,
};

/** What the inventory reads about the session's current turn. */
export interface AgeRefreshTurn {
	/** The session is running a turn. */
	streaming: boolean;
	/** The provider is still streaming an assistant message. */
	providerStreaming: boolean;
	/** Tool name of each executing tool call, by call id. */
	pendingToolCalls: ReadonlyMap<string, string>;
	/** Tool call ids of open questions the agent waits on inline (not continued past). */
	openInlineAsks: ReadonlySet<string>;
}

/**
 * True when the turn only waits for the user to answer inline questions and none of
 * `others` is running work. Such a turn is not work to wait for or report: the
 * question is checkpointed, and after the refresh its answer becomes the same tool
 * call's result and the turn resumes.
 */
export function turnAwaitsOnlyInlineAsk(turn: AgeRefreshTurn, others: readonly AgeRefreshInterrupted[]): boolean {
	if (!turn.streaming || turn.providerStreaming || turn.pendingToolCalls.size === 0) return false;
	for (const [id, name] of turn.pendingToolCalls) {
		if (name !== "ask" || !turn.openInlineAsks.has(id)) return false;
	}
	return !others.some(item => STOPPED_WORK_KINDS[item.kind]);
}

/** `items` with the running turn first, unless it only waits on inline questions. */
export function withRunningTurn(items: AgeRefreshInterrupted[], turn: AgeRefreshTurn): AgeRefreshInterrupted[] {
	if (!turn.streaming || turnAwaitsOnlyInlineAsk(turn, items)) return items;
	return [{ kind: "turn", id: "turn", label: "the response in progress" }, ...items];
}

function hoursToMs(hours: number): number {
	return Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : 0;
}

export function readAgeRefreshPolicy(settings: Settings): AgeRefreshPolicy {
	const graceSeconds = cfgRefreshAgeHardGraceSeconds.get(settings);
	return {
		enabled: cfgRefreshAgeEnabled.get(settings),
		softMs: hoursToMs(cfgRefreshAgeSoftHours.get(settings)),
		hardMs: hoursToMs(cfgRefreshAgeHardHours.get(settings)),
		hardGraceMs: Number.isFinite(graceSeconds) && graceSeconds > 0 ? Math.round(graceSeconds * 1000) : 0,
	};
}

/** Which tier the age has reached; the forced tier wins once both have. */
export function ageRefreshDue(ageMs: number, policy: AgeRefreshPolicy): AgeRefreshDue {
	if (!policy.enabled) return "none";
	if (policy.hardMs > 0 && ageMs >= policy.hardMs) return "hard";
	if (policy.softMs > 0 && ageMs >= policy.softMs) return "soft";
	return "none";
}

export function runtimeAgeMs(now = Date.now()): number {
	return Math.max(0, now - RUNTIME_STARTED_AT);
}

let lastRefresh: CentralChatLastAgeRefresh | undefined;

/** Set once this runtime has restored a forced refresh's checkpoint; published in `age.lastRefresh`. */
export function recordLastAgeRefresh(record: CentralChatLastAgeRefresh): void {
	lastRefresh = record;
}

/** The `age` a chat publishes in its Central snapshot. */
export function centralChatAge(settings: Settings, now = Date.now()): CentralChatAge {
	const policy = readAgeRefreshPolicy(settings);
	const ageMs = runtimeAgeMs(now);
	return {
		v: 1,
		startedAt: RUNTIME_STARTED_AT,
		ageMs,
		...policy,
		due: ageRefreshDue(ageMs, policy),
		...(lastRefresh ? { lastRefresh } : {}),
	};
}

/** This process's resident and (Linux only) swapped memory, for the age-refresh log lines. */
export function processMemory(): { rssBytes: number; swapBytes?: number } {
	const rssBytes = process.memoryUsage().rss;
	if (process.platform !== "linux") return { rssBytes };
	try {
		const swapKb = /^VmSwap:\s+(\d+)\s+kB$/m.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1];
		return swapKb === undefined ? { rssBytes } : { rssBytes, swapBytes: Number(swapKb) * 1024 };
	} catch {
		return { rssBytes };
	}
}

/** Wire validation; the request id is checked by the host with the other operations' rule. */
export function parseCentralAgeRefreshRequest(value: Record<string, unknown>): CentralAgeRefreshRequest | null {
	const { sessionId, pid, startedAt } = value;
	const blockers = value.blockers ?? [];
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		sessionId.length > 256 ||
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		typeof startedAt !== "number" ||
		!Number.isSafeInteger(startedAt) ||
		startedAt <= 0 ||
		!Array.isArray(blockers) ||
		blockers.length > AGE_REFRESH_MAX_BLOCKERS ||
		!blockers.every(
			blocker =>
				typeof blocker === "string" &&
				blocker.length > 0 &&
				blocker.length <= AGE_REFRESH_MAX_BLOCKER_LENGTH &&
				/^[\x20-\x7e]+$/.test(blocker),
		)
	)
		return null;
	return { sessionId, pid, startedAt, blockers: blockers as string[] };
}
