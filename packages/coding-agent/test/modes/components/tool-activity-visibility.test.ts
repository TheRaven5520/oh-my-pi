import { beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolActivityContainer } from "@oh-my-pi/pi-tui/chrome/tool-activity";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { Text } from "@oh-my-pi/pi-tui";

const darkTheme = await getThemeByName("dark");

describe("tool activity visibility", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("applies visibility to mounted and subsequently added activity blocks", () => {
		const rule: Rule = {
			name: "ts-no-tiny-functions",
			path: "/rules/ts-no-tiny-functions.md",
			content: "Inline tiny wrappers.",
			_source: {
				provider: "test",
				providerName: "Test",
				path: "/rules/ts-no-tiny-functions.md",
				level: "project",
			},
		};
		const transcript = new TranscriptContainer();
		transcript.addChild(new TtsrNotificationComponent([rule]));
		transcript.addChild(new TodoReminderComponent([{ content: "finish the task", status: "in_progress" }], 1, 3));
		transcript.addChild(new ToolActivityContainer(new Text("tool warning", 1, 0)));

		const visible = stripVTControlCharacters(transcript.render(120).join("\n"));
		expect(visible).toContain("ts-no-tiny-functions");
		expect(visible).toContain("finish the task");
		expect(visible).toContain("tool warning");

		transcript.setToolDisplayState("hidden");
		expect(stripVTControlCharacters(transcript.render(120).join("\n"))).toBe("");
		transcript.addChild(new ToolActivityContainer(new Text("late activity", 1, 0)));
		expect(stripVTControlCharacters(transcript.render(120).join("\n"))).toBe("");

		transcript.setToolDisplayState("verbose");
		const restored = stripVTControlCharacters(transcript.render(120).join("\n"));
		expect(restored).toContain("ts-no-tiny-functions");
		expect(restored).toContain("finish the task");
		expect(restored).toContain("tool warning");
		expect(restored).toContain("late activity");
	});

	it("forwards Ctrl+O expansion to wrapped expandable components", () => {
		// The transcript expansion traversal only visits top-level children;
		// without forwarding, a wrapped renderer freezes at insertion-time state.
		const states: boolean[] = [];
		class ExpandableText extends Text {
			setExpanded(expanded: boolean): void {
				states.push(expanded);
			}
		}
		const wrapper = new ToolActivityContainer(new ExpandableText("activity", 1, 0));
		wrapper.setExpanded(true);
		wrapper.setExpanded(false);
		expect(states).toEqual([true, false]);
	});
	it.each([false, true])("keeps finished tools visible in claude, including failures (%s)", isError => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const tool = new ToolExecutionComponent("test-tool", { value: "active" }, {}, undefined, ui);
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		transcript.addChild(tool);
		try {
			tool.updateResult({ content: [{ type: "text", text: "settled result" }], isError }, false);
			expect(transcript.render(100).length).toBeGreaterThan(0);
			expect(tool.describe().p?.hidden).not.toBe(true);
			transcript.setToolDisplayState("hidden");
			expect(transcript.render(100)).toEqual([]);
			expect(tool.describe().p?.hidden).toBe(true);
			transcript.setToolDisplayState("claude");
			expect(transcript.render(100).length).toBeGreaterThan(0);
		} finally {
			tool.stopAnimation();
		}
	});

	it("keeps settled read groups listed in claude", () => {
		const group = new ReadToolGroupComponent();
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		group.updateArgs({ path: "/tmp/settled.ts" }, "done");
		transcript.addChild(group);
		group.updateResult({ content: [{ type: "text", text: "ok" }] }, false, "done");
		group.seal();
		expect(stripVTControlCharacters(transcript.render(100).join("\n"))).toContain("settled.ts");
	});

	it("reactivates a running tool retired while hidden and keeps it after it finishes", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const tool = new ToolExecutionComponent("test-tool", {}, {}, undefined, ui);
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("hidden");
		transcript.addChild(tool);
		try {
			const hiddenBatch = transcript.peekFlushBatch(100);
			expect(hiddenBatch).toBeDefined();
			transcript.acknowledgeFinalizedBatch(hiddenBatch!.id);
			expect(transcript.blockStates()).toEqual(["committed"]);
			transcript.setToolDisplayState("claude");
			transcript.beginReplay();
			expect(transcript.blockStates()).toEqual(["active"]);
			expect(transcript.liveRowCount(100)).toBeGreaterThan(0);
			tool.updateResult({ content: [{ type: "text", text: "finished after reveal" }] }, false);
			expect(transcript.liveRowCount(100)).toBeGreaterThan(0);
		} finally {
			tool.stopAnimation();
		}
	});

	it("shows notices in claude and hides them in hidden", () => {
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		transcript.addChild(new ToolActivityContainer(new Text("completed job", 0, 0)));
		expect(stripVTControlCharacters(transcript.render(100).join("\n"))).toContain("completed job");
		transcript.setToolDisplayState("hidden");
		expect(transcript.render(100)).toEqual([]);
	});

	it("shows non-blocker advisor notes only in verbose, and blockers in every state", () => {
		const transcript = new TranscriptContainer();
		const concern = createAdvisorMessageCard(
			{ notes: [{ note: "CONCERN_ONLY_NOTE", severity: "concern" }] },
			() => false,
			darkTheme!,
		);
		const mixed = createAdvisorMessageCard(
			{
				notes: [
					{ note: "BLOCKER_NOTE", severity: "blocker" },
					{ note: "NIT_BESIDE_BLOCKER", severity: "nit" },
				],
			},
			() => true,
			darkTheme!,
		);
		transcript.addChild(concern);
		transcript.addChild(mixed);
		const rendered = () => stripVTControlCharacters(transcript.render(120).join("\n"));
		for (const state of ["hidden", "claude"] as const) {
			transcript.setToolDisplayState(state);
			expect(rendered()).not.toContain("CONCERN_ONLY_NOTE");
			expect(rendered()).not.toContain("NIT_BESIDE_BLOCKER");
			expect(rendered()).toContain("BLOCKER_NOTE");
			expect(concern.describe!({ cols: 120 } as never)?.p?.hidden).toBe(true);
		}
		transcript.setToolDisplayState("verbose");
		expect(rendered()).toContain("CONCERN_ONLY_NOTE");
		expect(rendered()).toContain("NIT_BESIDE_BLOCKER");
		expect(rendered()).toContain("BLOCKER_NOTE");
	});

	it("shows answered questions in full in every state, while other tools follow the state", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const ask = new ToolExecutionComponent(
			"ask",
			{ question: "PICK_A_DATABASE", options: [{ label: "SQLite" }, { label: "Postgres" }] },
			{},
			undefined,
			ui,
		);
		const bash = new ToolExecutionComponent("bash", { command: "echo BASH_CMD" }, {}, undefined, ui);
		ask.updateResult(
			{
				content: [{ type: "text", text: "answered" }],
				details: {
					question: "PICK_A_DATABASE",
					options: ["SQLite", "Postgres"],
					multi: false,
					selectedOptions: [],
					customInput: "MY_CUSTOM_ANSWER",
				},
			},
			false,
		);
		bash.updateResult({ content: [{ type: "text", text: "BASH_OUT" }] }, false);
		const transcript = new TranscriptContainer();
		transcript.addChild(bash);
		transcript.addChild(ask);
		const rendered = () => stripVTControlCharacters(transcript.render(100).join("\n"));
		try {
			for (const state of ["hidden", "claude", "verbose"] as const) {
				transcript.setToolDisplayState(state);
				// Transcript-wide collapse, as claude applies, must not fold the answer away.
				ask.setExpanded(state === "verbose");
				expect(rendered()).toContain("PICK_A_DATABASE");
				expect(rendered()).toContain("MY_CUSTOM_ANSWER");
				expect(ask.describe().p?.hidden).not.toBe(true);
				if (state === "hidden") expect(rendered()).not.toContain("BASH_CMD");
				else expect(rendered()).toContain("BASH_CMD");
			}
		} finally {
			ask.stopAnimation();
			bash.stopAnimation();
		}
	});

	it("treats a malformed ask like any other tool: hidden in hidden, collapsed in claude", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const ask = new ToolExecutionComponent("ask", { questions: [{ id: "q" }] }, {}, undefined, ui);
		const transcript = new TranscriptContainer();
		transcript.addChild(ask);
		const rendered = () => stripVTControlCharacters(transcript.render(100).join("\n"));
		try {
			transcript.setToolDisplayState("hidden");
			ask.setExpanded(false);
			ask.updateResult(
				{ content: [{ type: "text", text: "VALIDATION_FAILED questions/0/question missing" }], isError: true },
				false,
			);
			expect(rendered()).toEqual("");
			expect(ask.describe().p?.hidden).toBe(true);
			transcript.setToolDisplayState("claude");
			ask.setExpanded(false);
			const collapsed = rendered();
			expect(collapsed).not.toEqual("");
			transcript.setToolDisplayState("verbose");
			ask.setExpanded(true);
			expect(rendered().length).toBeGreaterThan(collapsed.length);
		} finally {
			ask.stopAnimation();
		}
	});

	for (const args of [
		{ questions: [{ id: "deploy", question: "Which deployment?", options: [{ label: "Blue" }, { label: "Green" }] }] },
		{ question: "Which deployment?", options: [{ label: "Blue" }, { label: "Green" }] },
	]) {
		it(`keeps a cancelled ${"questions" in args ? "multi-question" : "single-question"} ask visible in hidden: the user saw it`, () => {
			const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
			const ask = new ToolExecutionComponent("ask", args, {}, undefined, ui);
			const transcript = new TranscriptContainer();
			transcript.addChild(ask);
			const rendered = () => stripVTControlCharacters(transcript.render(100).join("\n"));
			try {
				transcript.setToolDisplayState("hidden");
				ask.setExpanded(false);
				ask.updateResult(
					{ content: [{ type: "text", text: "Ask tool was cancelled by the user" }], isError: true },
					false,
				);
				expect(rendered()).toContain("Ask tool was cancelled by the user");
				expect(ask.describe().p?.hidden).not.toBe(true);
			} finally {
				ask.stopAnimation();
			}
		});
	}
});
