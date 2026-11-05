/**
 * What a forced age refresh writes into the session before the process is
 * replaced, and how the next process restores it.
 */
import type { CentralChatLastAgeRefresh } from "@oh-my-pi/pi-tui/apps/central/types";
import type { AskDialogDraftState } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import type { ComposerDraftSnapshot } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import type { AskContinuation } from "@oh-my-pi/pi-tui/tools/ask";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgeRefreshInterrupted } from "../central/age-refresh";
import type { SessionEntry } from "../session/session-entries";
import type { AskToolInput } from "../tools/ask";

/** Machine state the next process restores (not sent to the model). */
export const AGE_REFRESH_CHECKPOINT_TYPE = "age-refresh-checkpoint";
/** Written by the process that restored a checkpoint, so it is restored once. */
export const AGE_REFRESH_RESTORED_TYPE = "age-refresh-restored";
/** Rides the aborted turn's error message. */
export const AGE_REFRESH_ABORT_REASON = "Stopped by an automatic refresh (process age limit)";

export interface AgeRefreshCheckpointAsk {
	toolCallId: string;
	questions: AskToolInput["questions"];
	/** Present when the agent had continued past the question; the answer is due as this background job. */
	continuation?: AskContinuation;
	/** Unsubmitted dialog answers; absent when the dialog was still waiting behind another one. */
	draft?: AskDialogDraftState;
}

export interface AgeRefreshCheckpoint {
	version: 1;
	id: string;
	at: number;
	ageMs: number;
	hardMs: number;
	graceMs: number;
	/** The composer, including images and messages that were queued but not yet sent. */
	draft?: ComposerDraftSnapshot;
	asks: AgeRefreshCheckpointAsk[];
	/** Work still running when the grace window ended, which the refresh stopped. */
	stopped: AgeRefreshInterrupted[];
}

/** `3`, `3.1`: whole numbers stay whole. */
function formatAmount(value: number): string {
	return String(Math.round(value * 10) / 10);
}

/**
 * The automatic prompt the resumed chat sends, or undefined when nothing was
 * stopped (then the refresh is only logged).
 */
export function formatAgeRefreshPrompt(checkpoint: AgeRefreshCheckpoint): string | undefined {
	if (checkpoint.stopped.length === 0) return undefined;
	const lines = [
		`[Automatic refresh] This chat was force-refreshed after ${formatAmount(checkpoint.ageMs / 86_400_000)} days without a refresh, to free memory. Work still running after a ${formatAmount(checkpoint.graceMs / 60_000)}-minute wait was stopped, so no results will arrive from it:`,
		...checkpoint.stopped.map(item => `- ${item.kind} ${item.label}${item.state ? `: ${item.state}` : ""}`),
		"Before continuing, take inventory: check each item's real state (processes, systemd units, files, remote jobs, commits); some may have finished, or may still be running outside this chat. Don't redo completed steps. Resume or restart only what is unfinished, and stop anything orphaned that is no longer needed. Then report briefly what you found and what you resumed.",
	];
	if (checkpoint.draft) lines.push("The user's unsent draft was restored to the input box; leave it alone.");
	if (checkpoint.asks.length > 0)
		lines.push(
			`${checkpoint.asks.length} question(s) to the user were restored and are still waiting for an answer.`,
		);
	return lines.join("\n");
}

/** The newest checkpoint no process has restored yet, if it is well formed. */
export function findPendingAgeRefreshCheckpoint(entries: readonly SessionEntry[]): AgeRefreshCheckpoint | undefined {
	let checkpoint: AgeRefreshCheckpoint | undefined;
	const restored = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === AGE_REFRESH_RESTORED_TYPE && isRecord(entry.data)) {
			const id = entry.data.checkpointId;
			if (typeof id === "string") restored.add(id);
		} else if (entry.customType === AGE_REFRESH_CHECKPOINT_TYPE) {
			const data = entry.data;
			if (
				isRecord(data) &&
				data.version === 1 &&
				typeof data.id === "string" &&
				Array.isArray(data.asks) &&
				Array.isArray(data.stopped)
			)
				checkpoint = data as unknown as AgeRefreshCheckpoint;
		}
	}
	return checkpoint && !restored.has(checkpoint.id) ? checkpoint : undefined;
}

export interface AgeRefreshRestoreHost {
	/** Persist that this checkpoint is being restored; returns the marker entry id. */
	markRestored(checkpointId: string): string;
	/** Put the composer back exactly as it was; never submits it. */
	restoreDraft(draft: ComposerDraftSnapshot): void;
	/** Re-open a question the agent continued past, under its original job id. */
	rearmContinued(ask: AgeRefreshCheckpointAsk & { continuation: AskContinuation }): void;
	/** Re-open the question the stopped turn was waiting on; settles in the background. */
	reopenInterrupted(ask: AgeRefreshCheckpointAsk, restoredLeafId: string): void;
	/** Send the automatic prompt as a user turn, leaving the composer untouched. */
	submitPrompt(text: string): Promise<void>;
	warn(message: string): void;
	record(lastRefresh: CentralChatLastAgeRefresh): void;
}

/**
 * Restore in order: draft, then every question, then (only if something was
 * stopped) the automatic prompt, so the prompt never consumes the draft and the
 * questions are open before the agent reads it.
 */
export async function restoreAgeRefreshCheckpoint(
	checkpoint: AgeRefreshCheckpoint,
	host: AgeRefreshRestoreHost,
): Promise<{ promptSubmitted: boolean }> {
	const restoredLeafId = host.markRestored(checkpoint.id);
	if (checkpoint.draft) host.restoreDraft(checkpoint.draft);
	for (const ask of checkpoint.asks) {
		try {
			if (ask.continuation) host.rearmContinued({ ...ask, continuation: ask.continuation });
			else host.reopenInterrupted(ask, restoredLeafId);
		} catch (error) {
			host.warn(
				`A question from before the automatic refresh could not be reopened: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const prompt = formatAgeRefreshPrompt(checkpoint);
	let promptSubmitted = false;
	if (prompt) {
		try {
			await host.submitPrompt(prompt);
			promptSubmitted = true;
		} catch (error) {
			host.warn(
				`The automatic refresh prompt could not be sent: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	host.record({
		trigger: "hard",
		checkpointId: checkpoint.id,
		promptSubmitted,
		stopped: checkpoint.stopped.length,
		restoredAt: Date.now(),
	});
	return { promptSubmitted };
}
