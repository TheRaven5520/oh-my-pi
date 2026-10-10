import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

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
			const blank = theme.bgFill("toolExpandedBg", " ".repeat(width));
			const background = theme.getBgAnsi("toolExpandedBg");
			expect(background).toBe("\x1b[48;2;18;52;86m");
			for (const card of [tool, bash, cell, read]) {
				const collapsed = card.render(width);
				expect(collapsed.every(line => !line.includes(background))).toBe(true);
				expect(card.toggleClickExpansion()).toBe(true);
				const expanded = card.render(width);
				expect(expanded.at(-1)).toBe(blank);
				expect(expanded.every(line => line.startsWith(background) && visibleWidth(line) === width)).toBe(true);
				card.setExpanded(true);
				expect(card.render(width).every(line => !line.includes(background))).toBe(true);
				card.setExpanded(false);
				expect(card.render(width)).toEqual(collapsed);
			}
		} finally {
			setThemeInstance(previousTheme);
		}
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
			expect(rows[1]).toBe(`⎿ ${lines} lines`);
		}
	});

	it("shows a one-line output whole instead of counting it", () => {
		const card = new ToolExecutionComponent("bash", { command: "echo hi" }, {}, undefined, ui, "/tmp");
		card.updateResult(
			{ content: [{ type: "text", text: "hi\n\nWall time: 0.01 seconds" }], details: { wallTimeMs: 10 } },
			false,
		);
		card.seal();
		expect(plain(card.render(120))[1]).toBe("⎿ hi");
	});

	it("recounts hidden lines when the same output gains notice details", () => {
		const card = new ToolExecutionComponent("bash", { command: "echo a" }, {}, undefined, ui, "/tmp");
		const text = "a\nb\n\nWall time: 0.02 seconds";
		card.updateResult({ content: [{ type: "text", text }], details: {} }, false);
		card.seal();
		expect(plain(card.render(120))[1]).toBe("⎿ 3 lines");
		// Same output string, new details: the notice is now known and hidden.
		card.updateResult({ content: [{ type: "text", text }], details: { wallTimeMs: 20 } }, false);
		expect(plain(card.render(120))[1]).toBe("⎿ 2 lines");
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
		expect(plain(first)[1]).toBe("⎿ 12 lines");
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
		expect(plain(card.render(80))[1]).toBe("⎿ 3 lines");
		expect(body.renders).toBe(1);
	});

	it("follows a running block's streamed tail while collapsed", () => {
		const card = new ToolExecutionComponent("counted", { path: "x" }, {}, undefined, ui, "/tmp");
		card.updateResult(textResult("first\nsecond"), true);
		expect(plain(card.render(80))[1]).toBe("⎿ second");
		card.updateResult(textResult("first\nsecond\nthird"), true);
		expect(plain(card.render(80))[1]).toBe("⎿ third");
		card.updateResult(textResult("first\nsecond\nthird"), false);
		card.seal();
		expect(plain(card.render(80))[1]).toBe("⎿ 3 lines");
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
