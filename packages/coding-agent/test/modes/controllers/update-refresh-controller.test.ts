import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgeRefreshInterrupted,
	type AgeRefreshTurn,
	RUNTIME_STARTED_AT,
	withRunningTurn,
} from "@oh-my-pi/pi-coding-agent/central/age-refresh";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UpdateRefreshController } from "@oh-my-pi/pi-coding-agent/modes/controllers/update-refresh-controller";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const dirs: TempDir[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) dir.removeSync();
});

function setup(overrides: Parameters<typeof createInteractiveModeContext>[0] = {}) {
	const dir = TempDir.createSync("@omp-update-refresh-");
	dirs.push(dir);
	const binary = path.join(dir.path(), "omp");
	fs.writeFileSync(binary, "old build");
	fs.chmodSync(binary, 0o755);
	const refresh = vi.fn(async () => {});
	const ctx = createInteractiveModeContext({
		refresh,
		isShuttingDown: false,
		hasPendingSubmission: () => false,
		hasActiveBtw: () => false,
		hasActiveOmfg: () => false,
		hasActiveCleanse: () => false,
		collabController: { host: undefined },
		session: { isStreaming: false, queuedMessageCount: 0, hasPendingAsyncWork: () => false },
		ui: { hasOverlay: () => false },
		editor: (() => {
			let text = "";
			return { getText: () => text, setText: (next: string) => (text = next), pendingImages: [] };
		})(),
		...overrides,
	});
	vi.spyOn(ctx.sessionManager, "getSessionFile").mockReturnValue(path.join(dir.path(), "session.jsonl"));
	let blocker: string | undefined;
	const controller = new UpdateRefreshController(ctx, {
		executablePath: binary,
		delayMs: 10,
		recheckMs: 10,
		idleCheckMs: 1_000,
		extraBlocker: () => blocker,
	});
	const install = (contents: string) => {
		// Same atomic swap as the installers: write beside, then rename over.
		const staged = `${binary}.new`;
		fs.writeFileSync(staged, contents);
		fs.chmodSync(staged, 0o755);
		fs.renameSync(staged, binary);
	};
	return { ctx, refresh, controller, install, block: (reason?: string) => (blocker = reason) };
}

describe("UpdateRefreshController", () => {
	it("does nothing at turn end when the installed binary is unchanged", () => {
		vi.useFakeTimers();
		const { controller, refresh } = setup();
		controller.onTurnSettled();
		vi.advanceTimersByTime(1_000);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("refreshes once a newly installed build is stable and the chat is idle", () => {
		vi.useFakeTimers();
		const { controller, refresh, install, ctx } = setup();
		install("new build");
		controller.onTurnSettled();
		vi.advanceTimersByTime(10);
		// First sighting only records the candidate; a still-changing file is never launched.
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("refreshing"));
	});

	it("waits while the install is still changing", () => {
		vi.useFakeTimers();
		const { controller, refresh, install } = setup();
		install("partial");
		controller.onTurnSettled();
		vi.advanceTimersByTime(10);
		install("complete build");
		vi.advanceTimersByTime(10);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("refreshes an idle chat on the hourly check without a turn ending", () => {
		vi.useFakeTimers();
		const { refresh, install, ctx } = setup();
		install("new build");
		Object.defineProperty(ctx.session, "isStreaming", { value: true, configurable: true });
		vi.advanceTimersByTime(1_000 + 10);
		// A streaming chat is left to its own turn end.
		expect(refresh).not.toHaveBeenCalled();
		Object.defineProperty(ctx.session, "isStreaming", { value: false, configurable: true });
		vi.advanceTimersByTime(999);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1 + 10);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	interface Blocker {
		extra?: string;
		draft?: string;
		overlay?: boolean;
		queued?: number;
	}
	it.each<[string, Blocker]>([
		["running subagent or fork", { extra: "forks open" }],
		["unsent draft", { draft: "half-typed message" }],
		["open dialog", { overlay: true }],
		["queued messages", { queued: 1 }],
	])("defers while blocked by %s, then refreshes when it clears", (_label, blocker) => {
		vi.useFakeTimers();
		const overlay = { open: blocker.overlay === true };
		const { controller, refresh, install, ctx, block } = setup();
		ctx.ui.hasOverlay = () => overlay.open;
		if (blocker.queued)
			Object.defineProperty(ctx.session, "queuedMessageCount", { value: blocker.queued, configurable: true });
		if (blocker.draft) ctx.editor.setText(blocker.draft);
		if (blocker.extra) block(blocker.extra);
		install("new build");
		controller.onTurnSettled();
		vi.advanceTimersByTime(100);
		expect(refresh).not.toHaveBeenCalled();

		overlay.open = false;
		if (blocker.queued) Object.defineProperty(ctx.session, "queuedMessageCount", { value: 0, configurable: true });
		if (blocker.draft) ctx.editor.setText("");
		block(undefined);
		vi.advanceTimersByTime(10);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("never refreshes away a question still waiting for an answer, then refreshes once it is answered", () => {
		vi.useFakeTimers();
		const jobs: Array<{ type: string }> = [{ type: "ask" }];
		const { controller, refresh, install, ctx } = setup();
		// The ask job is not "work" (it never blocks waits), yet a restart would lose it.
		Object.defineProperty(ctx.session, "asyncJobManager", {
			value: { getRunningWorkJobs: () => [], getRunningJobs: () => jobs },
			configurable: true,
		});
		install("new build");
		controller.onTurnSettled();
		vi.advanceTimersByTime(100);
		expect(refresh).not.toHaveBeenCalled();
		jobs.length = 0;
		vi.advanceTimersByTime(10);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("never refreshes source launches with no installed binary", () => {
		vi.useFakeTimers();
		const ctx = createInteractiveModeContext({ refresh: vi.fn(async () => {}) });
		const controller = new UpdateRefreshController(ctx, { executablePath: undefined, delayMs: 1, recheckMs: 1 });
		controller.onTurnSettled();
		vi.advanceTimersByTime(100);
		expect(ctx.refresh).not.toHaveBeenCalled();
	});

	describe("age refresh", () => {
		const HOUR = 3_600_000;
		function ageSetup(settings: Record<string, unknown> = {}) {
			const forceAgeRefresh = vi.fn(async (_info: { ageMs: number; hardMs: number; graceMs: number }) => {});
			const running: AgeRefreshInterrupted[] = [{ kind: "job", id: "bg_1", label: "sleep 600" }];
			const ageRefreshInventory = vi.fn(() => [...running]);
			const beginAgeDrain = vi.fn();
			const ctx = setup({
				settings: Settings.isolated(settings),
				forceAgeRefresh,
				ageRefreshInventory,
				beginAgeDrain,
				collabGuest: undefined,
			});
			const request = (overrides: Record<string, unknown> = {}) => ({
				sessionId: ctx.ctx.sessionManager.getSessionId(),
				pid: process.pid,
				startedAt: RUNTIME_STARTED_AT,
				blockers: [] as string[],
				...overrides,
			});
			const at = (hours: number) => RUNTIME_STARTED_AT + hours * HOUR;
			return { ...ctx, forceAgeRefresh, ageRefreshInventory, beginAgeDrain, running, request, at };
		}

		it("reports the runtime's own start and does nothing below the limits", () => {
			const { controller, request, at, refresh } = ageSetup();
			const { result, start } = controller.handleAgeRefresh(request(), at(23));
			expect(result.outcome).toBe("not-due");
			expect(result.runtime).toEqual({ pid: process.pid, startedAt: RUNTIME_STARTED_AT, ageMs: 23 * HOUR });
			expect(result.settings).toEqual({ enabled: true, softMs: 24 * HOUR, hardMs: 72 * HOUR, hardGraceMs: 120_000 });
			expect(start).toBeUndefined();
			expect(refresh).not.toHaveBeenCalled();
		});

		it.each([
			["another pid", { pid: process.pid + 1 }],
			["an earlier start (same pid after exec)", { startedAt: RUNTIME_STARTED_AT - 1 }],
			["another session", { sessionId: "other-session" }],
		])("refuses a request for %s as a stale runtime", (_label, overrides) => {
			const { controller, request, at } = ageSetup();
			const { result, start } = controller.handleAgeRefresh(request(overrides), at(100));
			expect(result.outcome).toBe("stale-runtime");
			expect(start).toBeUndefined();
		});

		it("is off when disabled, and a tier set to 0 never fires", () => {
			const disabled = ageSetup({ "refresh.age.enabled": false });
			expect(disabled.controller.handleAgeRefresh(disabled.request(), disabled.at(1_000)).result.outcome).toBe(
				"disabled",
			);
			const softOff = ageSetup({ "refresh.age.softHours": 0 });
			expect(softOff.controller.handleAgeRefresh(softOff.request(), softOff.at(48)).result.outcome).toBe("not-due");
			const hardOff = ageSetup({ "refresh.age.hardHours": 0 });
			hardOff.ctx.editor.setText("draft");
			const deferred = hardOff.controller.handleAgeRefresh(hardOff.request(), hardOff.at(500)).result;
			expect(deferred).toMatchObject({ outcome: "deferred", trigger: "soft", reason: "soft: unsent draft" });
		});

		it("soft: defers on any idle blocker, including the worker's, then refreshes after the reply", () => {
			const { controller, request, at, refresh, ctx } = ageSetup();
			ctx.editor.setText("half-typed");
			expect(controller.handleAgeRefresh(request(), at(30)).result.reason).toBe("soft: unsent draft");
			ctx.editor.setText("");
			expect(controller.handleAgeRefresh(request({ blockers: ["tmux-copy-mode"] }), at(30)).result.reason).toBe(
				"soft: tmux-copy-mode",
			);
			const decision = controller.handleAgeRefresh(request(), at(30));
			expect(decision.result).toMatchObject({ outcome: "refreshing", trigger: "soft" });
			// Nothing happens until the reply has gone out.
			expect(refresh).not.toHaveBeenCalled();
			expect(controller.handleAgeRefresh(request(), at(30)).result.outcome).toBe("deferred");
			decision.start?.();
			expect(refresh).toHaveBeenCalledTimes(1);
		});

		it("hard: opens one runtime-owned grace window that repeats never restart, then stops what still runs at the deadline", () => {
			vi.useFakeTimers();
			const { controller, request, at, ctx, beginAgeDrain, forceAgeRefresh, refresh } = ageSetup();
			ctx.editor.setText("half-typed");
			const first = controller.handleAgeRefresh(request({ blockers: ["tmux-copy-mode"] }), at(72));
			expect(first.result).toMatchObject({
				outcome: "deferred",
				trigger: "hard",
				reason: "draining: 120 s left; waiting for job sleep 600",
			});
			expect(first.start).toBeUndefined();
			expect(first.result.settings.hardGraceMs).toBe(120_000);
			expect(beginAgeDrain).toHaveBeenCalledWith(120_000);
			// No further request is needed; a repeat only reads the countdown.
			vi.advanceTimersByTime(60_000);
			const repeat = controller.handleAgeRefresh(request(), at(72) + 60_000);
			expect(repeat.result.reason).toBe("draining: 60 s left; waiting for job sleep 600");
			expect(repeat.result.interrupted).toEqual([{ kind: "job", id: "bg_1", label: "sleep 600" }]);
			expect(beginAgeDrain).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(59_999);
			expect(forceAgeRefresh).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(forceAgeRefresh).toHaveBeenCalledTimes(1);
			expect(forceAgeRefresh).toHaveBeenCalledWith(expect.objectContaining({ hardMs: 72 * HOUR, graceMs: 120_000 }));
			// The plain /refresh path, which refuses mid-turn, is never used for the forced tier.
			expect(refresh).not.toHaveBeenCalled();
		});

		it("hard: refreshes as soon as running work drains, before the deadline", () => {
			vi.useFakeTimers();
			const { controller, request, at, running, forceAgeRefresh } = ageSetup({
				"refresh.age.hardGraceSeconds": 300,
			});
			expect(controller.handleAgeRefresh(request(), at(73)).result.reason).toStartWith("draining: 300 s left");
			vi.advanceTimersByTime(5_000);
			expect(forceAgeRefresh).not.toHaveBeenCalled();
			running.length = 0;
			vi.advanceTimersByTime(1_000);
			expect(forceAgeRefresh).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(300_000);
			expect(forceAgeRefresh).toHaveBeenCalledTimes(1);
		});

		it("hard: refreshes right after the reply when nothing runs, and is blocked only when the session cannot resume", () => {
			const ready = ageSetup();
			ready.running.length = 0;
			const decision = ready.controller.handleAgeRefresh(ready.request(), ready.at(80));
			expect(decision.result.outcome).toBe("refreshing");
			expect(ready.beginAgeDrain).not.toHaveBeenCalled();
			decision.start?.();
			expect(ready.forceAgeRefresh).toHaveBeenCalledTimes(1);
			const unsaved = ageSetup();
			vi.spyOn(unsaved.ctx.sessionManager, "getSessionFile").mockReturnValue(undefined);
			expect(unsaved.controller.handleAgeRefresh(unsaved.request(), unsaved.at(80)).result).toMatchObject({
				outcome: "blocked",
				trigger: "hard",
			});
		});

		describe("a turn waiting on an inline question", () => {
			const ASK: AgeRefreshInterrupted = { kind: "ask", id: "call_1", label: "kept open: Which database?" };
			const JOB: AgeRefreshInterrupted = { kind: "job", id: "bg_1", label: "sleep 600" };
			const waitingOnAsk = (overrides: Partial<AgeRefreshTurn> = {}): AgeRefreshTurn => ({
				streaming: true,
				providerStreaming: false,
				pendingToolCalls: new Map([["call_1", "ask"]]),
				openInlineAsks: new Set(["call_1"]),
				...overrides,
			});

			it("is not running work: the forced tier refreshes at once, with nothing to report as stopped", () => {
				const { controller, request, at, running, beginAgeDrain, forceAgeRefresh } = ageSetup();
				running.splice(0, running.length, ...withRunningTurn([ASK], waitingOnAsk()));
				const decision = controller.handleAgeRefresh(request(), at(80));
				expect(decision.result).toMatchObject({ outcome: "refreshing", trigger: "hard" });
				expect(decision.result.reason).toStartWith("hard: nothing running");
				expect(decision.result.interrupted).toEqual([ASK]);
				expect(beginAgeDrain).not.toHaveBeenCalled();
				decision.start?.();
				expect(forceAgeRefresh).toHaveBeenCalledTimes(1);
			});

			it("counts as running work alongside other running work, until that finishes", () => {
				vi.useFakeTimers();
				const { controller, request, at, running, beginAgeDrain, forceAgeRefresh } = ageSetup();
				running.splice(0, running.length, ...withRunningTurn([JOB, ASK], waitingOnAsk()));
				const first = controller.handleAgeRefresh(request(), at(80));
				expect(first.result.reason).toBe(
					"draining: 120 s left; waiting for turn the response in progress, job sleep 600",
				);
				expect(beginAgeDrain).toHaveBeenCalledTimes(1);
				// The job finishes; only the question is left, so the refresh need not wait out the window.
				running.splice(0, running.length, ...withRunningTurn([ASK], waitingOnAsk()));
				vi.advanceTimersByTime(1_000);
				expect(forceAgeRefresh).toHaveBeenCalledTimes(1);
			});

			it.each([
				["the provider is still streaming", { providerStreaming: true }],
				[
					"another tool call runs beside the question",
					{
						pendingToolCalls: new Map([
							["call_1", "ask"],
							["call_2", "read"],
						]),
					},
				],
				["the agent continued past the question", { openInlineAsks: new Set<string>() }],
				["no tool call is executing", { pendingToolCalls: new Map<string, string>() }],
			])("still counts the turn when %s", (_label, overrides) => {
				expect(withRunningTurn([ASK], waitingOnAsk(overrides))[0]?.kind).toBe("turn");
			});

			it("lists no turn when the session is not streaming", () => {
				expect(withRunningTurn([ASK], waitingOnAsk({ streaming: false }))).toEqual([ASK]);
			});
		});
	});
});
