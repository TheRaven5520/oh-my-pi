import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setTuiTight, visibleWidth } from "@oh-my-pi/pi-tui/utils";

const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function surface(component: Component, width: number, label: string): string[] {
	const transcript = new TranscriptContainer();
	transcript.addChild(component);
	const rows = transcript.renderViewport(width, 100, { tick: 0, now: 0 });
	for (const row of rows) expect(visibleWidth(row), label).toBeLessThanOrEqual(width);
	const plain = rows.map(row => Bun.stripANSI(row).trimEnd());
	transcript.dispose();
	return plain;
}

function expectColumn(rows: string[], text: string, column = 3): void {
	const row = rows.find(row => row.includes(text));
	expect(row, `missing ${text}`).toBeDefined();
	expect(row!.indexOf(text) + 1, row).toBe(column);
}

const output = "Output first line with enough words to wrap at narrow width.\nOutput second line";

describe("transcript content column", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	for (const width of [32, 48, 120]) {
		it(`aligns message, live thinking, and code content at width ${width}`, () => {
			for (const tight of [false, true]) {
				setTuiTight(tight);
				try {
					const user = surface(
						new UserMessageComponent(
							"User first line\nUser second line with enough words to wrap around a narrow transcript surface.",
						),
						width,
						"user",
					);
					expectColumn(user, "User first");
					expectColumn(user, "User second");
					for (const row of user.slice(1).filter(Boolean)) expect(row.startsWith("  ")).toBe(true);
					const prose = surface(
						new AssistantMessageComponent(
							message([
								{
									type: "text",
									text: "Assistant prose with enough words to wrap around a narrow transcript surface.\n\n- List item\n  - Nested item\n\n```\ncode body\n```",
								},
							]),
						),
						width,
						"assistant",
					);
					expectColumn(prose, "Assistant");
					expectColumn(prose, "code body");
					expectColumn(prose, "Nested item", 7);
					const thinking = new AssistantMessageComponent();
					thinking.updateContent(
						message([
							{
								type: "thinking",
								thinking: "Live thinking with enough words to wrap around a narrow transcript surface.",
							},
						]),
						{ transient: true },
					);
					const thought = surface(thinking, width, "thinking");
					expectColumn(thought, "Live thinking");
					for (const row of thought.filter(Boolean)) expect(row.search(/\S/)).toBe(2);
				} finally {
					setTuiTight(false);
				}
			}
		});

		it(`aligns tool labels, summaries, errors and expanded content at width ${width}`, () => {
			for (const expanded of [false, true]) {
				for (const error of [false, true]) {
					for (const name of ["bash", "unknown"]) {
						const tool = new ToolExecutionComponent(name, { command: "printf sample" }, {}, undefined, ui);
						tool.updateResult({ content: [{ type: "text", text: output }], isError: error });
						tool.setExpanded(expanded, true);
						const rows = surface(tool, width, `${name} expanded=${expanded} error=${error}`);
						if (expanded) expectColumn(rows, "Output first");
						else {
							expectColumn(rows, name);
							expect(rows[1]?.search(/\S/)).toBe(2);
						}
					}
				}
				// These components only consume the UI repaint callbacks in this fixture.
				const bash = new BashExecutionComponent("printf sample", ui as TUI);
				bash.setComplete(0, false, { output });
				bash.setExpanded(expanded, true);
				const bashRows = surface(bash, width, `shell expanded=${expanded}`);
				expectColumn(bashRows, "printf sample");
				if (expanded) expectColumn(bashRows, "Output first");
				const cell = new EvalExecutionComponent("print('sample')", ui as TUI);
				cell.setComplete(0, false, { output });
				cell.setExpanded(expanded, true);
				const cellRows = surface(cell, width, `cell expanded=${expanded}`);
				expectColumn(cellRows, ">>>");
				if (expanded) expectColumn(cellRows, "Output first");
				else expect(cellRows[1]?.search(/\S/)).toBe(2);
				const read = new ReadToolGroupComponent();
				read.updateArgs({ path: "example.txt" }, "read");
				read.updateResult({ content: [{ type: "text", text: output }] }, false, "read");
				read.setExpanded(expanded, true);
				expectColumn(surface(read, width, `read expanded=${expanded}`), "Read");
			}
		});
	}
	it("keeps multiline shell commands, read wraps, hidden thinking and provider errors aligned", () => {
		const bash = new BashExecutionComponent(
			"printf first\nprintf second with many words to force a wrapped command line",
			ui as TUI,
		);
		bash.setComplete(0, false, { output });
		bash.setExpanded(true, true);
		const shell = surface(bash, 32, "multiline shell");
		expectColumn(shell, "printf first");
		expectColumn(shell, "printf second");
		const read = new ReadToolGroupComponent();
		read.updateArgs({ path: "directory/with/a/long/path/that/will/wrap/example.txt" }, "read");
		read.updateResult({ content: [{ type: "text", text: output }] }, false, "read");
		read.setExpanded(true, true);
		const readRows = surface(read, 32, "wrapped read").filter(Boolean);
		expectColumn(readRows, "Read");
		for (const row of readRows.slice(1)) expect(row.startsWith("  ")).toBe(true);
		const preview = new ReadToolGroupComponent({ showContentPreview: true });
		preview.updateArgs({ path: "example.txt" }, "read");
		preview.updateResult(
			{ content: [{ type: "text", text: output }], details: { displayContent: { text: output, startLine: 1 } } },
			false,
			"read",
		);
		preview.setExpanded(true, true);
		expect(surface(preview, 48, "expanded read preview").some(row => row.includes("Output first"))).toBe(true);
		const hidden = new AssistantMessageComponent(undefined, true);
		hidden.updateContent(message([{ type: "thinking", thinking: "Working" }]), { transient: true });
		expectColumn(surface(hidden, 48, "hidden thinking pulse"), "Thinking");
		const error = message([]);
		error.stopReason = "error";
		error.errorMessage = "Provider failure with enough words to wrap at narrow width and continue on another line.";
		const errors = surface(new AssistantMessageComponent(error), 32, "provider error").filter(Boolean);
		expectColumn(errors, "Error:");
		for (const row of errors) expect(row.search(/\S/)).toBe(2);
	});
});
