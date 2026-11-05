import { formatDuration, logger } from "@oh-my-pi/pi-utils";
import {
	type AgeRefreshInterrupted,
	type AgeRefreshOutcome,
	ageRefreshDue,
	type CentralAgeRefreshRequest,
	type CentralAgeRefreshResult,
	processMemory,
	RUNTIME_STARTED_AT,
	readAgeRefreshPolicy,
	runtimeAgeMs,
	STOPPED_WORK_KINDS,
} from "../../central/age-refresh";
import { type BinaryIdentity, readBinaryIdentity, sameIdentity } from "../../installed-build";
import { AgentRegistry } from "../../registry/agent-registry";
import type { InteractiveModeContext } from "../types";

/** How often a draining forced refresh checks whether running work has finished. */
export const AGE_DRAIN_POLL_MS = 1_000;

/** An `ageRefresh` decision; `start` runs once the reply has been sent. */
export interface AgeRefreshDecision {
	result: CentralAgeRefreshResult;
	start?: () => void;
}

/** Work owned by this process that a restart would cut off, beyond what `ctx` exposes. */
export type ExtraRefreshBlocker = () => string | undefined;

/**
 * Why an automatic refresh must wait, or undefined when the chat is fully idle:
 * the turn is over, nothing it started is still running, and the user is not
 * in the middle of typing, choosing, or watching something a restart would lose.
 */
export function autoRefreshBlocker(ctx: InteractiveModeContext, extra?: ExtraRefreshBlocker): string | undefined {
	const session = ctx.session;
	if (ctx.isShuttingDown) return "shutting down";
	if (session.isStreaming) return "turn in progress";
	if (session.queuedMessageCount > 0) return "queued messages";
	if (session.hasPendingAsyncWork()) return "pending background wake";
	if ((session.asyncJobManager?.getRunningWorkJobs().length ?? 0) > 0) return "background jobs running";
	// A question the agent continued past lives only in this process; a restart
	// would drop it unanswered, so wait for the answer (or its withdrawal).
	if ((session.asyncJobManager?.getRunningJobs().filter(job => job.type === "ask").length ?? 0) > 0)
		return "open question";
	if (
		AgentRegistry.global()
			.list()
			.some(agent => agent.kind === "sub" && agent.status === "running")
	) {
		return "subagents running";
	}
	if (ctx.focusedAgentId) return "viewing a subagent";
	if (ctx.collabGuest || ctx.collabController.host) return "collaboration session";
	if (ctx.loopModeEnabled && !ctx.loopModePaused) return "loop mode";
	if (ctx.goalModeEnabled && !ctx.goalModePaused) return "goal mode";
	if (ctx.hasPendingSubmission()) return "submission pending";
	if (ctx.ui.hasOverlay()) return "dialog open";
	if (ctx.hasActiveBtw() || ctx.hasActiveOmfg() || ctx.hasActiveCleanse()) return "side request active";
	if (ctx.editor.getText().trim().length > 0 || (ctx.editor.pendingImages?.length ?? 0) > 0) return "unsent draft";
	if (!ctx.sessionManager.getSessionFile()) return "unsaved session";
	return extra?.();
}

export interface UpdateRefreshOptions {
	/** Running executable; undefined disables the feature (source/SDK launches). */
	executablePath?: string;
	/** Settle time after a turn ends before the first check. */
	delayMs?: number;
	/** Recheck interval while the chat is busy or the install is still settling. */
	recheckMs?: number;
	/** How often an idle chat checks for a new build without waiting for a turn to end. */
	idleCheckMs?: number;
	extraBlocker?: ExtraRefreshBlocker;
}

/**
 * Restart into the newly installed OMP build once the chat is idle, the same
 * way `/refresh` does. Checks run after every turn settles and hourly while
 * idle. The running binary's identity is captured at startup; a different file
 * at the same path means an install replaced it. A change must be seen
 * unchanged on two consecutive checks so a file still being written is never
 * launched.
 */
export class UpdateRefreshController {
	readonly #ctx: InteractiveModeContext;
	readonly #path: string | undefined;
	readonly #startup: BinaryIdentity | undefined;
	readonly #delayMs: number;
	readonly #recheckMs: number;
	readonly #extraBlocker: ExtraRefreshBlocker | undefined;
	#timer: NodeJS.Timeout | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	#candidate: BinaryIdentity | undefined;
	#refreshing = false;
	/** The forced tier's grace window; owned by this runtime, started once, never restarted. */
	#drain: { deadlineAt: number; poll: NodeJS.Timeout; deadline: NodeJS.Timeout } | undefined;

	constructor(ctx: InteractiveModeContext, options: UpdateRefreshOptions) {
		this.#ctx = ctx;
		this.#path = options.executablePath;
		this.#startup = this.#path ? readBinaryIdentity(this.#path) : undefined;
		this.#delayMs = options.delayMs ?? 2_000;
		this.#recheckMs = options.recheckMs ?? 5_000;
		this.#extraBlocker = options.extraBlocker;
		if (this.#startup) {
			this.#idleTimer = setInterval(() => {
				// A pending check already owns the next decision.
				if (!this.#refreshing && !this.#timer) this.#check();
			}, options.idleCheckMs ?? 3_600_000);
			this.#idleTimer.unref?.();
		}
	}

	/** Whether the installed file at the running path differs from the one this process started from. */
	installedBuildChanged(): BinaryIdentity | undefined {
		if (!this.#path || !this.#startup) return undefined;
		const current = readBinaryIdentity(this.#path);
		return current && !sameIdentity(current, this.#startup) ? current : undefined;
	}

	/** Called when a turn has fully settled. */
	onTurnSettled(): void {
		if (!this.#startup || this.#refreshing) return;
		this.#schedule(this.#delayMs);
	}

	dispose(): void {
		this.#clearTimer();
		if (this.#idleTimer) clearInterval(this.#idleTimer);
		this.#idleTimer = undefined;
		this.#endDrain();
	}

	/**
	 * Decide a Central `ageRefresh` request. The external worker only asks; this
	 * runtime checks that the request is for this very process, reads its own
	 * settings, and refreshes only when its age and state allow it.
	 */
	handleAgeRefresh(request: CentralAgeRefreshRequest, now = Date.now()): AgeRefreshDecision {
		const settings = readAgeRefreshPolicy(this.#ctx.settings);
		const ageMs = runtimeAgeMs(now);
		const decide = (
			outcome: AgeRefreshOutcome,
			trigger: "soft" | "hard" | null,
			reason: string,
			interrupted: AgeRefreshInterrupted[] = [],
		): CentralAgeRefreshResult => ({
			v: 1,
			outcome,
			trigger,
			reason,
			runtime: { pid: process.pid, startedAt: RUNTIME_STARTED_AT, ageMs },
			settings,
			interrupted,
		});
		if (
			request.pid !== process.pid ||
			request.startedAt !== RUNTIME_STARTED_AT ||
			request.sessionId !== this.#ctx.sessionManager.getSessionId()
		)
			return { result: decide("stale-runtime", null, "pid, start time or session differs from this runtime") };
		if (!settings.enabled) return { result: decide("disabled", null, "refresh.age.enabled is off") };
		const due = ageRefreshDue(ageMs, settings);
		if (due === "none")
			return { result: decide("not-due", null, `age ${formatDuration(ageMs)} is below every limit`) };
		// Every drain reply names what it still waits for and sets aside, as the first one did.
		if (this.#drain)
			return { result: decide("deferred", "hard", this.#drainReason(now), this.#ctx.ageRefreshInventory()) };
		if (this.#refreshing) return { result: decide("deferred", due, `${due}: a refresh is already in progress`) };
		if (due === "soft") {
			const blocker = autoRefreshBlocker(this.#ctx, this.#extraBlocker) ?? request.blockers[0];
			if (blocker) return { result: decide("deferred", "soft", `soft: ${blocker}`) };
			this.#refreshing = true;
			return {
				result: decide("refreshing", "soft", `soft: idle at age ${formatDuration(ageMs)}`),
				start: () => this.#startSoftAgeRefresh(ageMs, settings.softMs),
			};
		}
		if (this.#ctx.isShuttingDown)
			return { result: decide("deferred", "hard", "hard: chat is already shutting down") };
		if (!this.#ctx.sessionManager.getSessionFile())
			return { result: decide("blocked", "hard", "hard: unsaved session cannot be resumed after a refresh") };
		if (this.#ctx.collabGuest)
			return { result: decide("blocked", "hard", "hard: collaboration guest; refresh the host chat") };
		const interrupted = this.#ctx.ageRefreshInventory();
		const running = interrupted.filter(item => STOPPED_WORK_KINDS[item.kind]);
		if (running.length === 0 || settings.hardGraceMs === 0) {
			this.#refreshing = true;
			return {
				result: decide(
					"refreshing",
					"hard",
					running.length > 0
						? `hard: stopping ${running.length} item(s) at age ${formatDuration(ageMs)}`
						: `hard: nothing running at age ${formatDuration(ageMs)}`,
					interrupted,
				),
				start: () => this.#startHardAgeRefresh(ageMs, settings.hardMs, settings.hardGraceMs),
			};
		}
		this.#startDrain(now, ageMs, settings.hardMs, settings.hardGraceMs);
		return { result: decide("deferred", "hard", this.#drainReason(now), interrupted) };
	}

	/**
	 * Let running work finish for up to the grace window while nothing new starts,
	 * then refresh: as soon as it drains, or at the deadline with whatever still runs
	 * stopped. The worker's later requests only read the countdown.
	 */
	#startDrain(now: number, ageMs: number, hardMs: number, graceMs: number): void {
		this.#ctx.beginAgeDrain(graceMs);
		logger.info("Age refresh (hard) draining", { ageMs, hardMs, graceMs, running: this.#runningWork() });
		const finish = (drained: boolean): void => {
			if (!this.#drain) return;
			this.#endDrain();
			logger.info("Age refresh (hard) grace ended", { drained, running: this.#runningWork() });
			this.#refreshing = true;
			this.#startHardAgeRefresh(ageMs + (Date.now() - now), hardMs, graceMs);
		};
		const poll = setInterval(() => {
			if (this.#runningWork().length === 0) finish(true);
		}, AGE_DRAIN_POLL_MS);
		const deadline = setTimeout(() => finish(false), graceMs);
		poll.unref?.();
		deadline.unref?.();
		this.#drain = { deadlineAt: now + graceMs, poll, deadline };
	}

	#endDrain(): void {
		if (!this.#drain) return;
		clearInterval(this.#drain.poll);
		clearTimeout(this.#drain.deadline);
		this.#drain = undefined;
	}

	#runningWork(): AgeRefreshInterrupted[] {
		return this.#ctx.ageRefreshInventory().filter(item => STOPPED_WORK_KINDS[item.kind]);
	}

	#drainReason(now: number): string {
		const left = Math.max(0, Math.ceil(((this.#drain?.deadlineAt ?? now) - now) / 1000));
		const waiting = this.#runningWork()
			.map(item => `${item.kind} ${item.label}`)
			.join(", ");
		return `draining: ${left} s left; waiting for ${waiting || "nothing"}`;
	}

	#startSoftAgeRefresh(ageMs: number, softMs: number): void {
		// Milliseconds passed while the reply was sent; typing may have started since.
		const blocker = autoRefreshBlocker(this.#ctx, this.#extraBlocker);
		if (blocker) {
			this.#refreshing = false;
			logger.info("Age refresh (soft) withdrawn after reply", { blocker, ageMs });
			return;
		}
		logger.info("Age refresh (soft) starting", { ageMs, softMs, ...processMemory() });
		this.#ctx.showStatus(`This chat has run ${formatDuration(ageMs)} since its last refresh — refreshing…`);
		this.#ctx.refresh().then(
			() => {
				// refresh() returns without exiting only when it refused to proceed.
				this.#refreshing = false;
			},
			error => {
				this.#refreshing = false;
				logger.warn("Age refresh (soft) failed", { error: String(error) });
			},
		);
	}

	#startHardAgeRefresh(ageMs: number, hardMs: number, graceMs: number): void {
		this.#ctx.forceAgeRefresh({ ageMs, hardMs, graceMs }).then(
			() => {
				// Returns only when the checkpoint or the refresh could not complete.
				this.#refreshing = false;
			},
			error => {
				this.#refreshing = false;
				logger.warn("Age refresh (hard) failed", { error: String(error) });
			},
		);
	}

	#clearTimer(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(delayMs: number): void {
		this.#clearTimer();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#check();
		}, delayMs);
		this.#timer.unref?.();
	}

	#check(): void {
		const changed = this.installedBuildChanged();
		if (!changed) {
			this.#candidate = undefined;
			return;
		}
		// A new turn owns the next settle; it reschedules the check itself.
		if (this.#ctx.session.isStreaming) return;
		if (!this.#candidate || !sameIdentity(this.#candidate, changed)) {
			this.#candidate = changed;
			this.#schedule(this.#recheckMs);
			return;
		}
		const blocker = autoRefreshBlocker(this.#ctx, this.#extraBlocker);
		if (blocker) {
			this.#schedule(this.#recheckMs);
			return;
		}
		this.#refreshing = true;
		this.#ctx.showStatus("New OMP build installed — refreshing this chat…");
		this.#ctx.refresh().then(
			() => {
				// refresh() returns without exiting only when it refused to proceed.
				this.#refreshing = false;
			},
			error => {
				this.#refreshing = false;
				logger.warn("Automatic refresh failed", { error: String(error) });
			},
		);
	}
}
