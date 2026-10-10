import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, type Component, Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { routeViewportClick, type ViewportClickSpan } from "@oh-my-pi/pi-tui/prompt/composer";

function span(start: number, end: number, ids: string[]): ViewportClickSpan {
	return { start, end, candidates: () => ids };
}

describe("routeViewportClick", () => {
	it("returns the hit span's candidates with the span-local row", () => {
		let local = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 0,
				end: 2,
				candidates: row => {
					local = row;
					return ["CardAgent"];
				},
			},
			{ start: 3, end: 5, candidates: () => ["HudAgent"] },
		];
		expect(routeViewportClick(spans, 1)).toEqual(["CardAgent"]);
		expect(local).toBe(1);
		expect(routeViewportClick(spans, 4)).toEqual(["HudAgent"]);
	});

	it("misses separators, out-of-range rows, and non-integer indexes", () => {
		const spans = [span(0, 2, ["A"]), span(3, 4, ["B"])];
		expect(routeViewportClick(spans, 2)).toEqual([]);
		expect(routeViewportClick(spans, -1)).toEqual([]);
		expect(routeViewportClick(spans, Number.NaN)).toEqual([]);
		expect(routeViewportClick(spans, 99)).toEqual([]);
	});

	it("lets the first overlapping span win", () => {
		const spans = [span(0, 5, ["A"]), span(2, 4, ["B"])];
		expect(routeViewportClick(spans, 3)).toEqual(["A"]);
	});
});

class RowTarget implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	render(): readonly string[] {
		return this.rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		return this.ids[row];
	}
}

describe("composer click-span clipping", () => {
	beforeAll(() => {
		initTheme();
	});

	it("offsets hit-testing past clipped viewport rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const ids = Array.from({ length: 10 }, (_, index) => `row${index}`);
			chrome.addChild(
				new RowTarget(
					ids.map(id => `line ${id}`),
					ids,
				),
			);
			composer.setRuntimeChildren([transcript, chrome]);

			// Ten chrome rows in a six-row viewport: the first four scroll off,
			// so viewport row 0 must hit-test as component row 4.
			const frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.viewport).toHaveLength(6);
			expect(composer.viewportClickCandidates(0)).toEqual(["row4"]);
			expect(composer.viewportClickCandidates(5)).toEqual(["row9"]);
		} finally {
			composer.stop();
		}
	});
});

class CountingBlock implements Component {
	renders = 0;
	constructor(private readonly rows: readonly string[]) {}
	render(): readonly string[] {
		this.renders++;
		return this.rows;
	}
}

describe("composer chrome span recording", () => {
	beforeAll(() => {
		initTheme();
	});

	it("does not re-render chrome without click targets", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const second = new CountingBlock(["status two"]);
			chrome.addChild(first);
			chrome.addChild(second);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			expect(frame.viewport.join("\n")).toContain("status two");
			expect([first.renders, second.renders]).toEqual([1, 1]);
			expect(composer.viewportClickCandidates(0)).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("renders target-bearing chrome children once per frame", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const hud = new RowTarget(["hud row"], ["AgentH"]);
			chrome.addChild(first);
			chrome.addChild(hud);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const hudRow = frame.viewport.findIndex(line => line.includes("hud row"));
			expect(hudRow).toBeGreaterThanOrEqual(0);
			expect(composer.viewportClickCandidates(hudRow)).toEqual(["AgentH"]);
			expect(first.renders).toBe(1);
		} finally {
			composer.stop();
		}
	});
});

/** Tool card that collapses to a header plus one summary row, like tool-execution. */
class ToolBlock implements Component {
	expanded = false;
	constructor(
		readonly id: string,
		readonly lines: number,
		readonly finalized: boolean,
	) {}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
	render(): readonly string[] {
		if (!this.expanded) return [`${this.id} header`, `${this.id} hidden ${this.lines}`];
		return [`${this.id} header`, ...Array.from({ length: this.lines }, (_, row) => `${this.id} line ${row}`)];
	}
	getClickToolId(): string {
		return this.id;
	}
	toggleClickExpansion(): boolean {
		this.expanded = !this.expanded;
		return true;
	}
}

describe("composer tool clicks on clipped and retired rows", () => {
	withoutTerminalMultiplexer();
	beforeAll(() => {
		initTheme();
	});

	async function mount(tool: ToolBlock) {
		const terminal = new VirtualTerminal(100, 40);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text("user prompt", 0, 0));
		transcript.addChild(tool);
		transcript.addChild(new Text("assistant reply", 0, 0));
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		let resets = 0;
		const resetDisplay = composer.ui.resetDisplay.bind(composer.ui);
		composer.ui.resetDisplay = () => {
			resets++;
			resetDisplay();
		};
		/** Click-handler hit-test: screen row to mutable-viewport index, negative above it. */
		const toolAt = (screenRow: number) =>
			composer.viewportClickToolId(screenRow - composer.ui.getMutableViewport().top);
		const rowsMatching = (text: string) =>
			terminal
				.getViewport()
				.map((line, row) => (line.includes(text) ? row : -1))
				.filter(row => row >= 0);
		return { terminal, scheduler, composer, transcript, resets: () => resets, toolAt, rowsMatching };
	}

	it("toggles a running block whose header is clipped above the viewport", async () => {
		const tool = new ToolBlock("live", 60, false);
		const h = await mount(tool);
		try {
			expect(h.composer.toggleViewportTool("live")).toBe(true);
			await h.scheduler.settle(h.terminal);
			// A running block cannot retire: the viewport keeps its newest rows
			// and clips the header and early rows off the top.
			expect(h.rowsMatching("live header")).toEqual([]);
			const visible = h.rowsMatching("live line");
			expect(visible[0]).toBe(0);
			expect(h.composer.ui.getMutableViewport().top).toBe(0);
			expect(h.transcript.canRemoveBlock(tool)).toBe(true);
			for (const row of visible) expect(h.toolAt(row)).toBe("live");

			expect(h.toolAt(0)).toBe("live");
			expect(h.composer.toggleViewportTool("live")).toBe(true);
			await h.scheduler.settle(h.terminal);
			expect(tool.expanded).toBe(false);
			expect(h.rowsMatching("EDITOR")).toEqual([39]);
			// Nothing was retired, so the plain repaint is consistent: the
			// collapsed card is whole and no expanded row survives anywhere.
			expect(h.resets()).toBe(0);
			const buffer = h.terminal.getScrollBuffer();
			expect(buffer.filter(line => line.includes("live line"))).toEqual([]);
			expect(buffer.filter(line => line.includes("live header"))).toHaveLength(1);
			expect(buffer.filter(line => line.includes("live hidden 60"))).toHaveLength(1);
		} finally {
			h.composer.stop();
		}
	});

	it("keeps the editor at the bottom after a large retired output collapses", async () => {
		const tool = new ToolBlock("large", 1000, true);
		const h = await mount(tool);
		try {
			h.composer.toggleViewportTool("large");
			await h.scheduler.settle(h.terminal);
			expect(h.rowsMatching("EDITOR")).toEqual([39]);
			const row = h.rowsMatching("large line").at(-1)!;
			expect(h.toolAt(row)).toBe("large");
			h.composer.toggleViewportTool("large");
			await h.scheduler.settle(h.terminal);
			expect(h.rowsMatching("EDITOR")).toEqual([39]);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			expect(h.rowsMatching("EDITOR")).toEqual([39]);
			expect(h.terminal.getScrollBuffer().some(line => line.includes("large line"))).toBe(false);
			expect(h.toolAt(h.rowsMatching("large header")[0]!)).toBe("large");
			h.composer.toggleViewportTool("large");
			await h.scheduler.settle(h.terminal);
			expect(h.rowsMatching("EDITOR")).toEqual([39]);
			h.composer.toggleViewportTool("large");
			await h.scheduler.settle(h.terminal);
			expect(h.rowsMatching("EDITOR")).toEqual([39]);
			expect(h.terminal.getScrollBuffer().filter(line => line.includes("large header"))).toHaveLength(1);
		} finally {
			h.composer.stop();
		}
	});

	it("toggles and replays a finished block whose visible rows already retired", async () => {
		const tool = new ToolBlock("done", 60, true);
		const h = await mount(tool);
		try {
			expect(h.composer.toggleViewportTool("done")).toBe(true);
			await h.scheduler.settle(h.terminal);
			// The expanded block no longer fits, so it retired whole: its last
			// rows are on screen but above the mutable viewport.
			const top = h.composer.ui.getMutableViewport().top;
			const visible = h.rowsMatching("done line");
			expect(visible.length).toBeGreaterThan(0);
			expect(visible.every(row => row < top)).toBe(true);
			// The transcript reports the block as retired: Ctrl+O's replay predicate.
			expect(h.transcript.canRemoveBlock(tool)).toBe(false);
			for (const row of visible) expect(h.toolAt(row)).toBe("done");
			expect(h.toolAt(h.rowsMatching("user prompt")[0] ?? top)).toBeUndefined();

			expect(h.toolAt(visible.at(-1)!)).toBe("done");
			expect(h.composer.toggleViewportTool("done")).toBe(true);
			await h.scheduler.settle(h.terminal);
			expect(tool.expanded).toBe(false);
			// The retired rows sit in native history, so the toggle replays it.
			expect(h.resets()).toBe(1);
			const buffer = h.terminal.getScrollBuffer();
			expect(buffer.filter(line => line.includes("done line"))).toEqual([]);
			expect(buffer.filter(line => line.includes("done header"))).toHaveLength(1);
			expect(buffer.filter(line => line.includes("done hidden 60"))).toHaveLength(1);
			expect(buffer.filter(line => line.includes("user prompt"))).toHaveLength(1);
			// The replayed card is live again and still toggles from its rows.
			const header = h.rowsMatching("done header")[0]!;
			expect(h.toolAt(header)).toBe("done");
		} finally {
			h.composer.stop();
		}
	});

	it("routes rows a replay paint replaced with history to their retired block", async () => {
		// A short frame whose leading composer rows are blank: the replay
		// splits history into those rows, so the published top sits above the
		// painted live top and the last history rows have local index >= 0.
		const terminal = new VirtualTerminal(100, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const tool = new ToolBlock("done", 30, true);
		tool.expanded = true;
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text("user prompt", 0, 0));
		transcript.addChild(tool);
		const editor = new Container();
		editor.addChild({ render: () => ["", "", "EDITOR"], invalidate() {} });
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			let resets = 0;
			const resetDisplay = composer.ui.resetDisplay.bind(composer.ui);
			composer.ui.resetDisplay = () => {
				resets++;
				resetDisplay();
			};
			// Paint listeners swallow throws, so the replay frame is sampled here
			// and asserted after it settles.
			const seen: Record<string, unknown> = {};
			const stop = composer.ui.addPaintListener(paint => {
				if (!paint.reset) return;
				const viewport = composer.ui.getMutableViewport();
				const rows = terminal.getViewport();
				const lastLine = rows.findIndex(row => row.includes("done line 29")) - viewport.top;
				const editorRow = rows.findIndex(row => row.includes("EDITOR")) - viewport.top;
				Object.assign(seen, {
					lastLineLocal: lastLine >= 0,
					editorInWindow: editorRow < viewport.length,
					lastLineTool: composer.viewportClickToolId(lastLine),
					lastLineCandidates: composer.viewportClickCandidates(lastLine),
					editorTool: composer.viewportClickToolId(editorRow),
				});
			});
			// Uncounted: only the toggle's own replay is counted below.
			resetDisplay();
			await scheduler.settle(terminal);
			stop();
			// The replaced rows are inside the published window (local >= 0), the
			// live rows still end inside it, and the history row hits its writer.
			expect(seen).toEqual({
				lastLineLocal: true,
				editorInWindow: true,
				lastLineTool: "done",
				lastLineCandidates: [],
				editorTool: undefined,
			});

			// A click landing after the replay paint but before the follow-up
			// frame its acknowledgement requests: queued ahead of that frame.
			let toggled: boolean | undefined;
			let queued = false;
			const stopClick = composer.ui.addPaintListener(paint => {
				if (!paint.reset || queued) return;
				queued = true;
				scheduler.scheduleImmediate(() => {
					const viewport = composer.ui.getMutableViewport();
					const row = terminal.getViewport().findIndex(line => line.includes("done line 29"));
					expect(row - viewport.top).toBeGreaterThanOrEqual(0);
					const id = composer.viewportClickToolId(row - viewport.top);
					toggled = id !== undefined && composer.toggleViewportTool(id);
				});
			});
			resetDisplay();
			await scheduler.settle(terminal);
			stopClick();
			expect(toggled).toBe(true);
			expect(tool.expanded).toBe(false);
			// The row was history, so the toggle replays instead of repainting.
			expect(resets).toBe(1);
			const buffer = terminal.getScrollBuffer();
			expect(buffer.filter(line => line.includes("done line"))).toEqual([]);
			expect(buffer.filter(line => line.includes("done hidden 30"))).toHaveLength(1);
		} finally {
			composer.stop();
		}
	});
});
