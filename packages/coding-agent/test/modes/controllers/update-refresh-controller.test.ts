import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { UpdateRefreshController } from "@oh-my-pi/pi-coding-agent/modes/controllers/update-refresh-controller";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

let dir: TempDir | undefined;
afterEach(() => {
	vi.useRealTimers();
	dir?.removeSync();
	dir = undefined;
});

function setup(overrides: Parameters<typeof createInteractiveModeContext>[0] = {}) {
	dir = TempDir.createSync("@omp-update-refresh-");
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

	it("never refreshes source launches with no installed binary", () => {
		vi.useFakeTimers();
		const ctx = createInteractiveModeContext({ refresh: vi.fn(async () => {}) });
		const controller = new UpdateRefreshController(ctx, { executablePath: undefined, delayMs: 1, recheckMs: 1 });
		controller.onTurnSettled();
		vi.advanceTimersByTime(100);
		expect(ctx.refresh).not.toHaveBeenCalled();
	});
});
