import { describe, expect, it, vi } from "bun:test";
import {
	AGE_REFRESH_CHECKPOINT_TYPE,
	AGE_REFRESH_RESTORED_TYPE,
	type AgeRefreshCheckpoint,
	type AgeRefreshRestoreHost,
	findPendingAgeRefreshCheckpoint,
	restoreAgeRefreshCheckpoint,
} from "@oh-my-pi/pi-coding-agent/modes/age-refresh-checkpoint";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ComposerDraftSnapshot } from "@oh-my-pi/pi-tui/prompt/custom-editor";

const HOUR = 3_600_000;

const DRAFT: ComposerDraftSnapshot = {
	version: 1,
	text: "half-typed [Image #1]",
	cursor: { line: 0, col: 4 },
	pastes: [],
	atoms: [],
	pasteCounter: 0,
	pendingImages: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
	pendingImageLinks: [null],
	imageLinks: null,
	pendingTexts: [],
	textAttachmentCounter: 0,
};

function checkpoint(overrides: Partial<AgeRefreshCheckpoint> = {}): AgeRefreshCheckpoint {
	return {
		version: 1,
		id: "cp-1",
		at: 1,
		ageMs: 74.4 * HOUR,
		hardMs: 72 * HOUR,
		graceMs: 120_000,
		asks: [],
		stopped: [],
		...overrides,
	};
}

const STOPPED = [
	{ kind: "turn", id: "turn", label: "the response in progress" },
	{ kind: "bash", id: "call_1", label: "make deploy", state: "tool call in progress" },
	{ kind: "subagent", id: "bg_4", label: "AuditDocs", state: "running 3m; last output: step 2/5" },
];

const ASKS = [
	{ toolCallId: "call_9", questions: [{ id: "deploy", question: "Deploy?", options: [{ label: "Yes" }] }] },
	{
		toolCallId: "call_3",
		questions: [{ id: "db", question: "Which DB?", options: [{ label: "SQLite" }] }],
		continuation: { jobId: "bg_1", askedAt: 0, afterMs: 60_000, assumptions: [] },
	},
];

function custom(customType: string, data: unknown, id: string): SessionEntry {
	return {
		type: "custom",
		customType,
		data,
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
	} as SessionEntry;
}

function fakeHost() {
	const events: string[] = [];
	const host: AgeRefreshRestoreHost = {
		markRestored: vi.fn(() => {
			events.push("marked");
			return "marker";
		}),
		restoreDraft: vi.fn(() => {
			events.push("draft");
		}),
		rearmContinued: vi.fn(ask => {
			events.push(`rearm ${ask.continuation.jobId}`);
		}),
		reopenInterrupted: vi.fn(ask => {
			events.push(`reopen ${ask.toolCallId}`);
		}),
		submitPrompt: vi.fn(async () => {
			events.push("prompt");
		}),
		warn: vi.fn(),
		record: vi.fn(),
	};
	return { host, events };
}

describe("age refresh checkpoint", () => {
	it("restores the draft and every question before the prompt, which never touches the draft", async () => {
		const { host, events } = fakeHost();
		const result = await restoreAgeRefreshCheckpoint(
			checkpoint({ stopped: STOPPED, asks: ASKS, draft: DRAFT }),
			host,
		);
		expect(events).toEqual(["marked", "draft", "reopen call_9", "rearm bg_1", "prompt"]);
		expect(host.restoreDraft).toHaveBeenCalledWith(DRAFT);
		expect(host.submitPrompt).toHaveBeenCalledWith(expect.not.stringContaining(DRAFT.text));
		expect(host.reopenInterrupted).toHaveBeenCalledWith(ASKS[0], "marker");
		expect(result.promptSubmitted).toBe(true);
		expect(host.record).toHaveBeenCalledWith(
			expect.objectContaining({ trigger: "hard", checkpointId: "cp-1", promptSubmitted: true, stopped: 3 }),
		);
	});

	it("sends no prompt when nothing was stopped, but still restores the draft and questions", async () => {
		const { host, events } = fakeHost();
		const result = await restoreAgeRefreshCheckpoint(checkpoint({ asks: ASKS, draft: DRAFT }), host);
		expect(events).toEqual(["marked", "draft", "reopen call_9", "rearm bg_1"]);
		expect(host.submitPrompt).not.toHaveBeenCalled();
		expect(result.promptSubmitted).toBe(false);
		expect(host.record).toHaveBeenCalledWith(expect.objectContaining({ promptSubmitted: false, stopped: 0 }));
	});

	it("still prompts when one question cannot be reopened, and reports it", async () => {
		const { host, events } = fakeHost();
		host.rearmContinued = vi.fn(() => {
			throw new Error("no job slot");
		});
		await restoreAgeRefreshCheckpoint(checkpoint({ stopped: STOPPED, asks: ASKS }), host);
		expect(events).toEqual(["marked", "reopen call_9", "prompt"]);
		expect(host.warn).toHaveBeenCalledWith(expect.stringContaining("no job slot"));
	});

	it("restores the newest checkpoint exactly once and skips malformed ones", () => {
		const first = checkpoint({ id: "cp-1" });
		const second = checkpoint({ id: "cp-2" });
		expect(findPendingAgeRefreshCheckpoint([custom(AGE_REFRESH_CHECKPOINT_TYPE, first, "a")])?.id).toBe("cp-1");
		expect(
			findPendingAgeRefreshCheckpoint([
				custom(AGE_REFRESH_CHECKPOINT_TYPE, first, "a"),
				custom(AGE_REFRESH_RESTORED_TYPE, { checkpointId: "cp-1" }, "b"),
			]),
		).toBeUndefined();
		expect(
			findPendingAgeRefreshCheckpoint([
				custom(AGE_REFRESH_CHECKPOINT_TYPE, first, "a"),
				custom(AGE_REFRESH_RESTORED_TYPE, { checkpointId: "cp-1" }, "b"),
				custom(AGE_REFRESH_CHECKPOINT_TYPE, second, "c"),
			])?.id,
		).toBe("cp-2");
		expect(
			findPendingAgeRefreshCheckpoint([custom(AGE_REFRESH_CHECKPOINT_TYPE, { version: 2, id: "x" }, "a")]),
		).toBeUndefined();
	});
});
