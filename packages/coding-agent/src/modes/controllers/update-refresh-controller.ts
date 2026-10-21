import * as fs from "node:fs";
import { isCompiledBinary, logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../../registry/agent-registry";
import type { InteractiveModeContext } from "../types";

/** File identity of an installed executable; an atomic install swaps in a new inode. */
export interface BinaryIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
}

export function readBinaryIdentity(executablePath: string): BinaryIdentity | undefined {
	try {
		const stat = fs.statSync(executablePath);
		if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o111) === 0) return undefined;
		return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	}
}

function sameIdentity(a: BinaryIdentity, b: BinaryIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
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

/** The running compiled executable; undefined for source/SDK launches, which have no installed binary. */
export function runningExecutablePath(): string | undefined {
	if (!isCompiledBinary()) return undefined;
	// Linux reports a replaced executable as "<path> (deleted)".
	return process.execPath.replace(/ \(deleted\)$/, "");
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
