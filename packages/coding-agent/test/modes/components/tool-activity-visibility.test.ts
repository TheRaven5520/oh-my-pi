import { beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
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
	it.each([false, true])("removes settled tools in claude, including failures (%s)", isError => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const tool = new ToolExecutionComponent("test-tool", { value: "active" }, {}, undefined, ui);
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		transcript.addChild(tool);
		try {
			expect(transcript.render(100).length).toBeGreaterThan(0);
			expect(tool.describe().p?.hidden).not.toBe(true);
			tool.updateResult({ content: [{ type: "text", text: "settled result" }], isError }, false);
			expect(transcript.render(100)).toEqual([]);
			expect(tool.describe().p?.hidden).toBe(true);
			transcript.setToolDisplayState("verbose");
			expect(transcript.render(100).length).toBeGreaterThan(0);
			expect(tool.describe().p?.hidden).not.toBe(true);
			transcript.setToolDisplayState("hidden");
			expect(transcript.render(100)).toEqual([]);
		} finally {
			tool.stopAnimation();
		}
	});

	it("keeps parked partial background work mutable until it settles", () => {
		const ui = { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
		const tool = new ToolExecutionComponent("test-tool", {}, {}, undefined, ui);
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		transcript.addChild(tool);
		try {
			tool.updateResult({ content: [{ type: "text", text: "working" }] }, true);
			tool.parkAsBackground();
			expect(tool.isTranscriptBlockFinalized()).toBe(false);
			expect(transcript.render(100).length).toBeGreaterThan(0);
			tool.updateResult({ content: [{ type: "text", text: "done" }] }, false);
			expect(transcript.render(100)).toEqual([]);
			expect(tool.isTranscriptBlockFinalized()).toBe(true);
		} finally {
			tool.stopAnimation();
		}
	});

	it("filters settled members of read groups and hides sealed pending reads", () => {
		const group = new ReadToolGroupComponent();
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		group.updateArgs({ path: "/tmp/settled.ts" }, "done");
		group.updateArgs({ path: "/tmp/pending.ts" }, "pending");
		transcript.addChild(group);
		group.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false, "done");
		const visible = stripVTControlCharacters(transcript.render(100).join("\n"));
		expect(visible).toContain("pending.ts");
		expect(visible).not.toContain("settled.ts");
		group.seal();
		expect(transcript.render(100)).toEqual([]);
		expect(group.describe().p?.hidden).toBe(true);
		transcript.setToolDisplayState("verbose");
		expect(stripVTControlCharacters(transcript.render(100).join("\n"))).toContain("settled.ts");
	});

	it("shows new pending reads after an active-only group has settled", () => {
		const group = new ReadToolGroupComponent();
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		group.updateArgs({ path: "/tmp/first.ts" }, "first");
		transcript.addChild(group);
		group.updateResult({ content: [{ type: "text", text: "first result" }] }, false, "first");
		expect(transcript.render(100)).toEqual([]);
		group.updateArgs({ path: "/tmp/second.ts" }, "second");
		const visible = stripVTControlCharacters(transcript.render(100).join("\n"));
		expect(visible).toContain("second.ts");
		expect(visible).not.toContain("first.ts");
	});

	it("reactivates a running tool retired while hidden, then removes its settled rows", () => {
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
			expect(transcript.liveRowCount(100)).toBe(0);
			expect(transcript.render(100)).toEqual([]);
			transcript.setToolDisplayState("verbose");
			expect(stripVTControlCharacters(transcript.render(100).join("\n"))).toContain("finished after reveal");
		} finally {
			tool.stopAnimation();
		}
	});

	it("does not show settled notices in claude", () => {
		const transcript = new TranscriptContainer();
		transcript.setToolDisplayState("claude");
		transcript.addChild(new ToolActivityContainer(new Text("completed job", 0, 0)));
		expect(transcript.render(100)).toEqual([]);
	});
});
