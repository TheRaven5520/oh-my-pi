import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const ui: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

function textResult(text: string) {
	return { content: [{ type: "text", text }] };
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

/** Result body that counts how often the card renders it. */
class CountingBody implements Component {
	renders = 0;
	constructor(private readonly rows: readonly string[]) {}
	render(): readonly string[] {
		this.renders++;
		return this.rows;
	}
}

describe("collapsed tool cards", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("retains the Eval title or code excerpt after expansion and collapse", () => {
		const code = "print('first visible line')\nprint('second line')";
		const card = new ToolExecutionComponent("eval", { code }, {}, undefined, ui, "/tmp");
		card.updateResult(textResult("first visible line\nsecond line"), false);
		card.seal();
		expect(plain(card.render(100))[0]).toContain(" · print('first visible line')");
		card.toggleClickExpansion();
		card.render(100);
		card.toggleClickExpansion();
		expect(plain(card.render(100))[0]).toContain(" · print('first visible line')");
		card.updateArgs({ code, title: "Summarizing the output of both printed lines" });
		expect(plain(card.render(100))[0]).toContain(" · Summarizing the output of both printed lines");
		const cropped = plain(card.render(24))[0]!;
		expect(cropped).toContain(" · Summarizing");
		expect(visibleWidth(cropped)).toBeLessThanOrEqual(24);
	});

	it("expands a clicked ask ahead of surrounding text under viewport pressure", () => {
		const question =
			"tmux 3.4 cannot bind focus events separately. The safe config-only fix removes the catch-all typing handler. Okay to require Escape before starting input with a non-ASCII character?";
		const options = ["Preserve focus reliably", "Keep current fallback"];
		const card = new ToolExecutionComponent(
			"ask",
			{
				i: "Choosing focus handling",
				questions: [{ id: "focus-fallback", question, options: options.map(label => ({ label })), multi: false }],
			},
			{},
			undefined,
			ui,
			"/tmp",
		);
		card.updateResult(
			{
				...textResult("User selected: Preserve focus reliably"),
				details: { question, options, multi: false, selectedOptions: [options[0]] },
			},
			false,
		);
		card.seal();
		const transcript = new TranscriptContainer();
		// A live predecessor prevents retirement; text normally wins the surplus
		// and leaves this card only two rows, even after its click state changes.
		transcript.addChild({
			render: () => Array.from({ length: 10 }, (_, index) => `Surrounding text ${index}`),
			isTranscriptBlockFinalized: () => false,
		} as Component);
		transcript.addChild(card);
		const frame = { tick: 0, now: 0 };
		const collapsed = plain(transcript.renderViewport(120, 12, frame));
		expect(collapsed.join("\n")).not.toContain("Keep current fallback");
		expect(card.getClickToolId()).toBeDefined();
		expect(card.toggleClickExpansion()).toBe(true);
		const expanded = plain(transcript.renderViewport(120, 12, frame));
		expect(expanded.length).toBeLessThanOrEqual(12);
		expect(expanded.join("\n")).toContain("tmux 3.4 cannot bind focus events separately.");
		expect(expanded.join("\n")).toContain("Preserve focus reliably");
		expect(expanded.join("\n")).toContain("Keep current fallback");
		expect(card.toggleClickExpansion()).toBe(true);
		expect(plain(transcript.renderViewport(120, 12, frame))).toEqual(collapsed);
	});

	it("keeps active wait progress visible under pressure until the invocation finishes", () => {
		const card = new ToolExecutionComponent("wait", {}, {}, undefined, ui, "/tmp");
		card.setExecutionStarted();
		const pending = plain(card.render(120)).join("\n");
		expect(pending).toContain("Wait");
		expect(pending).not.toContain("Background work or peer message");
		const transcript = new TranscriptContainer();
		transcript.addChild({
			render: () => Array.from({ length: 39 }, (_, index) => `Surrounding text ${index}`),
			isTranscriptBlockFinalized: () => false,
		} as Component);
		transcript.addChild(card);
		const frame = { tick: 0, now: 0 };
		const result = {
			...textResult("Still waiting for jobs"),
			details: {
				op: "wait",
				jobs: Array.from({ length: 10 }, (_, index) => ({
					id: `job-${index}`,
					type: "bash",
					status: "running",
					label: `Visible progress ${index}`,
					durationMs: 1000,
				})),
			},
		};
		card.updateResult(result, true);
		const progressRows = plain(transcript.renderViewport(120, 40, frame));
		expect(progressRows.length).toBeLessThanOrEqual(40);
		const progress = progressRows.join("\n");
		for (let index = 0; index < 10; index++) expect(progress).toContain(`Visible progress ${index}`);
		// A completed poll may still report running jobs. It is now a permanent
		// result, unlike the transient progress above, and may condense normally.
		card.updateResult(result, false);
		const completed = plain(card.render(120));
		expect(completed).toHaveLength(2);
		expect(completed.join("\n")).not.toContain("Visible progress");
		const finished = plain(transcript.renderViewport(120, 40, frame)).join("\n");
		expect(finished).toContain("Surrounding text 38");
		expect(finished).not.toContain("Visible progress");
		card.seal();
	});

	it("paints individual expansions full-width, not collapsed or globally expanded cards", () => {
		const previousTheme = theme;
		const json = structuredClone(getBuiltinThemes().dark!);
		json.colors.toolExpandedBg = "#123456";
		setThemeInstance(createTheme(json, { mode: "truecolor" }));
		try {
			const output = "first\nsecond\nthird\nfourth";
			const tool = new ToolExecutionComponent("unknown", {}, {}, undefined, ui, "/tmp");
			tool.updateResult(textResult(output), false);
			tool.seal();
			const framedBash = new ToolExecutionComponent("bash", { command: "printf lines" }, {}, undefined, ui, "/tmp");
			framedBash.updateResult(textResult(output), false);
			framedBash.seal();
			const bash = new BashExecutionComponent("printf lines", ui as TUI);
			bash.setComplete(0, false, { output });
			const cell = new EvalExecutionComponent("print('lines')", ui as TUI);
			cell.setComplete(0, false, { output });
			const read = new ReadToolGroupComponent({ showContentPreview: true });
			read.updateArgs({ path: "a.txt" }, "read");
			read.updateResult(
				{ ...textResult(output), details: { displayContent: { text: output, startLine: 1 } } },
				false,
				"read",
			);
			const width = 60;
			const background = theme.getBgAnsi("toolExpandedBg");
			expect(background).toBe("\x1b[48;2;18;52;86m");
			for (const card of [tool, framedBash, bash, cell, read]) {
				const collapsed = card.render(width);
				expect(collapsed.every(line => !line.includes(background))).toBe(true);
				expect(card.toggleClickExpansion()).toBe(true);
				const expanded = card.render(width);
				expect(Bun.stripANSI(expanded.at(-1)!).trim()).not.toBe("");
				expect(expanded.every(line => line.startsWith(background) && visibleWidth(line) === width)).toBe(true);
				expect(Bun.stripANSI(expanded[0]!).trim()).not.toBe("");
				for (const row of expanded) {
					expect(row.match(/\x1b\[(?:4[0-7]|10[0-7]|48[;:][0-9;:]+)m/g)?.every(open => open === background)).toBe(
						true,
					);
				}
				card.setExpanded(true);
				expect(card.render(width).every(line => !line.includes(background))).toBe(true);
				card.setExpanded(false);
				expect(card.render(width)).toEqual(collapsed);
			}
		} finally {
			setThemeInstance(previousTheme);
		}
	});

	it("keeps both real rows when an individual card gets exactly two rows", () => {
		// Render-only tool fixture; execution/schema fields are not consumed.
		const tool = {
			name: "two",
			label: "Two",
			renderCall: () => ({ render: () => ["header"] }),
			renderResult: () => ({ render: () => ["body"] }),
		} as unknown as AgentTool;
		const card = new ToolExecutionComponent("two", {}, {}, tool, ui, "/tmp");
		card.updateResult(textResult("first\nsecond"), false);
		card.seal();
		card.render(40);
		expect(card.toggleClickExpansion()).toBe(true);
		card.setTranscriptAllocation(2, { tick: 0, now: 0 });
		expect(plain(card.render(40)).map(row => row.trim())).toEqual(["header", "body"]);
	});

	it("counts every hidden output line, not the collapsed preview", () => {
		for (const [command, lines] of [
			["seq 1 40", 40],
			["ls /usr/bin | head -60", 60],
		] as const) {
			const card = new ToolExecutionComponent("bash", { command }, {}, undefined, ui, "/tmp");
			// Real bash results end with the model-facing wall-time notice, which the
			// card hides and must not count.
			const output = Array.from({ length: lines }, (_, index) => `out ${index + 1}`).join("\n");
			card.updateResult(
				{ content: [{ type: "text", text: `${output}\n\nWall time: 0.02 seconds` }], details: { wallTimeMs: 20 } },
				false,
			);
			card.seal();
			const rows = plain(card.render(120));
			expect(rows).toHaveLength(2);
			expect(rows[0]).toContain(command);
			expect(rows[1]).toEndWith(` ${lines} lines`);
		}
	});

	it("shows a one-line output whole instead of counting it", () => {
		const card = new ToolExecutionComponent("bash", { command: "echo hi" }, {}, undefined, ui, "/tmp");
		card.updateResult(
			{ content: [{ type: "text", text: "hi\n\nWall time: 0.01 seconds" }], details: { wallTimeMs: 10 } },
			false,
		);
		card.seal();
		expect(plain(card.render(120))[1]).toEndWith(" hi");
	});

	it("recounts hidden lines when the same output gains notice details", () => {
		const card = new ToolExecutionComponent("bash", { command: "echo a" }, {}, undefined, ui, "/tmp");
		const text = "a\nb\n\nWall time: 0.02 seconds";
		card.updateResult({ content: [{ type: "text", text }], details: {} }, false);
		card.seal();
		expect(plain(card.render(120))[1]).toEndWith(" 3 lines");
		// Same output string, new details: the notice is now known and hidden.
		card.updateResult({ content: [{ type: "text", text }], details: { wallTimeMs: 20 } }, false);
		expect(plain(card.render(120))[1]).toEndWith(" 2 lines");
	});

	it("keeps only the header in a one-row allocation", () => {
		const card = new ToolExecutionComponent("bash", { command: "seq 1 3" }, {}, undefined, ui, "/tmp");
		card.updateResult(textResult("1\n2\n3"), false);
		card.seal();
		expect(plain(card.render(120))).toHaveLength(2);
		card.setTranscriptAllocation(1, { tick: 0, now: 0 });
		const rows = plain(card.render(120));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("seq 1 3");
	});

	it("keeps a collapsed card off its child tree on unchanged frames", () => {
		const body = new CountingBody(Array.from({ length: 12 }, (_, index) => `body row ${index}`));
		const tool = {
			name: "counted",
			label: "Counted",
			renderResult: () => body,
		} as unknown as AgentTool;
		const card = new ToolExecutionComponent("counted", { path: "x" }, {}, tool, ui, "/tmp");
		card.updateResult(textResult(Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n")), false);
		card.seal();

		const first = card.render(80);
		expect(plain(first)[1]).toEndWith(" 12 lines");
		const second = card.render(80);
		expect(body.renders).toBe(0);
		expect(second).toBe(first);
		// A width change re-lays the card out, still without the child tree.
		expect(card.render(60)).not.toBe(first);
		expect(body.renders).toBe(0);

		card.setExpanded(true);
		expect(plain(card.render(80)).join("\n")).toContain("body row 11");
		expect(body.renders).toBe(1);

		card.setExpanded(false);
		expect(plain(card.render(80))).toEqual(plain(first));
		card.render(80);
		expect(body.renders).toBe(1);

		// A new result invalidates the memo.
		card.updateResult(textResult("only\nthree\nlines"), false);
		expect(plain(card.render(80))[1]).toEndWith(" 3 lines");
		expect(body.renders).toBe(1);
	});

	it("follows a running block's streamed tail while collapsed", () => {
		const card = new ToolExecutionComponent("counted", { path: "x" }, {}, undefined, ui, "/tmp");
		card.updateResult(textResult("first\nsecond"), true);
		expect(plain(card.render(80))[1]).toEndWith(" second");
		card.updateResult(textResult("first\nsecond\nthird"), true);
		expect(plain(card.render(80))[1]).toEndWith(" third");
		card.updateResult(textResult("first\nsecond\nthird"), false);
		card.seal();
		expect(plain(card.render(80))[1]).toEndWith(" 3 lines");
	});

	it("keeps every running task agent in spawn order across interleaved updates", () => {
		const names = ["AdvisorOneLine2", "ClaudeTheme", "CardsReview"];
		const progress: AgentProgress[] = names.map((id, index) => ({
			index,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "Inspect rendering",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		}));
		const args = { tasks: names.map(name => ({ name, task: "Inspect rendering" })) };
		const card = new ToolExecutionComponent("task", args, {}, undefined, ui, "/tmp");
		const update = (index: number) => {
			progress[index]!.recentOutput = [`Update from ${names[index]}`];
			const details: TaskToolDetails = {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				// Arrival order need not be dispatch order.
				progress: [progress[2]!, progress[0]!, progress[1]!].map(entry => ({ ...entry })),
			};
			const result = { ...textResult(`Running agent ${names[index]}...`), details };
			card.updateResult(result, true);
			return result;
		};
		try {
			for (const index of [0, 2, 1]) {
				update(index);
				expect(plain(card.render(100))[1]).toEndWith(` Running 3 agents: ${names.join(", ")}`);
				// Native task cards already carry all agent nodes, not the text tail.
				const nativeNames = card
					.describe()
					.c?.flatMap(child => ("k" in child && child.k === "agent" ? [child.p?.name] : []));
				expect(nativeNames).toEqual([names[2], names[0], names[1]]);
			}
			const narrow = card.render(40);
			expect(plain(narrow)[1]).toEndWith("…");
			expect(narrow.every(row => visibleWidth(row) <= 40)).toBe(true);
			card.setExpanded(true);
			const expanded = plain(card.render(100)).join("\n");
			for (const name of names) expect(expanded).toContain(name);
			expect(expanded).not.toContain("Running 3 agents:");
			card.setExpanded(false);
			progress[1]!.status = "completed";
			update(2);
			expect(plain(card.render(100))[1]).toEndWith(" Running 2 agents: AdvisorOneLine2, CardsReview");
			progress[0]!.status = "failed";
			const lastUpdate = update(2);
			expect(plain(card.render(100))[1]).toEndWith(" Running agent CardsReview");
			// The same payload settling must invalidate the live-summary cache.
			card.updateResult(lastUpdate, false);
			expect(plain(card.render(100))[1]).toEndWith(" Running agent CardsReview...");
			progress[2]!.status = "completed";
			card.updateResult(textResult("All agents complete"), false);
			expect(plain(card.render(100))[1]).toEndWith(" All agents complete");
		} finally {
			card.seal();
		}
	});

	it("ticks elapsed seconds on a running collapsed header and drops them once settled", () => {
		const card = new ToolExecutionComponent("bash", { command: "sleep 6" }, {}, undefined, ui, "/tmp");
		card.setExecutionStarted();
		const started = performance.now();
		card.setTranscriptAllocation(2, { tick: 1, now: started + 2500 });
		expect(plain(card.render(80))[0]).toMatch(/sleep 6 2s$/);
		card.setTranscriptAllocation(2, { tick: 2, now: started + 4100 });
		expect(plain(card.render(80))[0]).toMatch(/sleep 6 4s$/);
		// With `/time` on, the block stamp carries the duration instead.
		setChatTranscriptDisplayPreferences({ showTimestamps: true });
		try {
			card.setTranscriptAllocation(2, { tick: 3, now: started + 5100 });
			expect(plain(card.render(80))[0]).toMatch(/sleep 6$/);
		} finally {
			setChatTranscriptDisplayPreferences({ showTimestamps: false });
		}
		card.updateResult(textResult("done"), false);
		card.seal();
		card.setTranscriptAllocation(2, { tick: 4, now: started + 6000 });
		expect(plain(card.render(80))[0]).not.toMatch(/\d+s$/);
	});
});
