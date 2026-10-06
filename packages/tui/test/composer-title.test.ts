import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Editor, type EditorTheme } from "../src/components/editor";
import { getComposerStyle } from "../src/components/composer/registry";
import { BUILTIN_EDITOR_BORDER_STYLES } from "../src/components/composer/types";
import { renderComposerShapePreview } from "../src/overlays/composer-shape-preview";
import { createStartupStatusLine } from "../src/status-line/startup";
import type { StatusLineGoalState, StatusLineSession } from "../src/status-line/host";
import type { ComposerFactsSource } from "../src/status-line/types";
import type { StatusLineComponent } from "../src/status-line/component";
import { loadThemeSync } from "../src/theme/loader";
import { type Theme, setThemeInstance, theme } from "../src/theme";
import { visibleWidth } from "../src/utils";
import { defaultEditorTheme } from "./test-themes";

const statusLines: StatusLineComponent[] = [];
let previousTheme: Theme | undefined;
let editorTheme: EditorTheme;
beforeEach(() => {
	previousTheme = theme;
	const testTheme = loadThemeSync("dark", { symbolPresetOverride: "unicode" });
	setThemeInstance(testTheme);
	// The shared editor fixture hardcodes ASCII borders independently of the
	// global theme. Use the same pinned Unicode chrome as the status renderer.
	editorTheme = {
		...defaultEditorTheme,
		symbols: { ...defaultEditorTheme.symbols, boxRound: testTheme.boxRound },
	};
});

function makeEditor(): Editor & { composerFacts: ComposerFactsSource | undefined } {
	return Object.assign(new Editor(editorTheme), { composerFacts: undefined });
}
afterEach(() => {
	for (const status of statusLines.splice(0)) status.dispose();
	if (previousTheme) setThemeInstance(previousTheme);
	previousTheme = undefined;
});

function fixture() {
	let title: string | undefined = "Named chat";
	let goal: StatusLineGoalState | undefined;
	const session: StatusLineSession = {
		state: { messages: [] },
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => title,
			getSessionId: () => "title-test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ tokens: 0, contextWindow: 1000, percent: 0 }),
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => goal,
	};
	const status = createStartupStatusLine({
		settings: {
			preset: "custom",
			leftSegments: ["mode"],
			rightSegments: ["session_name", "context_pct"],
			separator: "ascii",
			sessionAccent: false,
			contextLine: "off",
		},
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
	status.setSession(session);
	status.setPlanModeStatus({ enabled: true, paused: false });
	statusLines.push(status);
	return {
		status,
		setTitle: (value: string | undefined) => {
			title = value;
		},
		setGoal: (value: StatusLineGoalState | undefined) => {
			goal = value;
		},
	};
}

function plain(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("composer session titles", () => {
	it("uses production top slots for five shapes and retains titles below chrome-free shapes", () => {
		const { status } = fixture();
		for (const shape of BUILTIN_EDITOR_BORDER_STYLES) {
			const lines = renderComposerShapePreview(shape, 80, status).map(plain);
			const topTitle = ["box", "band", "claude", "pi", "rule"].includes(shape);
			expect(lines[0].includes("Named chat")).toBe(topTitle);
			expect(lines.filter(line => line.includes("Named chat"))).toHaveLength(1);
			if (topTitle) {
				expect(lines[0].indexOf("Named chat")).toBeGreaterThan(60);
				expect(lines.slice(1).join("\n")).not.toContain("Named chat");
			} else {
				expect(lines.at(-1)).toContain("Named chat");
			}
			if (["rule", "field", "rail"].includes(shape)) expect(lines.at(-2)).toBe("");
			if (["claude", "rule", "pi", "borderless", "field", "rail"].includes(shape)) {
				expect(lines.at(-1)).toContain("Plan");
			}
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	it("updates a live pi top rule on rename and restores the status title when changing to rail", () => {
		const { status, setTitle } = fixture();
		const editor = makeEditor();
		editor.setBorderStyle("pi");
		status.attachToEditor(editor, getComposerStyle("pi"));
		expect(plain(editor.render(80)[0])).toContain("Named chat");
		expect(plain(status.renderBottomBar(80, "full"))).not.toContain("Named chat");
		setTitle("Renamed chat");
		expect(plain(editor.render(80)[0])).toContain("Renamed chat");
		editor.setBorderStyle("rail");
		status.attachToEditor(editor, getComposerStyle("rail"));
		expect(plain(editor.render(80).join("\n"))).not.toContain("Renamed chat");
		expect(plain(status.renderBottomBar(80, "full"))).toContain("Renamed chat");
	});

	it("respects hidden titles and handles unnamed sessions without a phantom live title", () => {
		const { status, setTitle } = fixture();
		const editor = makeEditor();
		editor.setBorderStyle("pi");
		status.attachToEditor(editor, getComposerStyle("pi"));
		setTitle(undefined);
		expect(plain(editor.render(40)[0])).toMatch(/^[─-]+$/);
		expect(renderComposerShapePreview("pi", 40, status).map(plain)[0]).toContain("omp");
		setTitle("Named chat");
		status.updateSettings({ preset: "custom", leftSegments: ["mode"], rightSegments: [] });
		expect(plain(editor.render(40)[0])).not.toContain("Named chat");
	});

	it("bounds Unicode titles and preserves top borders across narrow live widths", () => {
		const { status, setTitle } = fixture();
		setTitle("界面 é ".repeat(40) + "\n\x1b]0;bad\x07");
		for (const shape of ["box", "band", "claude", "pi", "rule"]) {
			const editor = makeEditor();
			editor.setBorderStyle(shape);
			status.attachToEditor(editor, getComposerStyle(shape));
			for (const width of [8, 14, 24, 40, 80]) {
				const top = editor.render(width)[0];
				expect(visibleWidth(top)).toBe(width);
				expect(top).not.toContain("\n");
				expect(top).not.toContain("\x1b]");
				const text = plain(top);
				if (shape === "box") {
					expect(text).toStartWith("╭");
					expect(text).toEndWith("╮");
				}
				if (["claude", "pi", "rule"].includes(shape)) {
					expect(text).toStartWith("─");
					expect(text).toEndWith("─");
				}
			}
		}
	});

	it("keeps extension titles in the status bar unless the style opts into a title slot", () => {
		const { status } = fixture();
		const { titleSlot: _titleSlot, ...legacyStyle } = getComposerStyle("box");
		const border = status.getComposerTopBorder(80, legacyStyle);
		expect(border.title).toBeUndefined();
		expect(plain(border.content)).toContain("Named chat");
	});
});

describe("goal active indicator", () => {
	it("right-aligns only running goals and invalidates on state transitions without a streaming event", () => {
		const { status, setGoal } = fixture();
		for (const groups of ["left", "full"] as const) {
			for (const state of ["active", "paused", "complete", "budget-limited", "dropped"]) {
				setGoal({ enabled: true, mode: "active", goal: { status: state, tokensUsed: 0 } });
				const line = plain(status.renderBottomBar(80, groups));
				expect(line.includes("(goal active)")).toBe(state === "active");
				if (state === "active") {
					expect(line).toEndWith("(goal active)");
					expect(visibleWidth(line)).toBe(80);
				}
			}
		}
		for (const goal of [
			undefined,
			{ enabled: false, mode: "active", goal: { status: "active", tokensUsed: 0 } },
			{ enabled: true, mode: "exiting", goal: { status: "active", tokensUsed: 0 } },
		]) {
			setGoal(goal);
			expect(plain(status.renderBottomBar(80, "full"))).not.toContain("(goal active)");
		}
	});

	it("keeps active goals intact beside the title on live box and band top rows", () => {
		const { status, setTitle, setGoal } = fixture();
		setTitle("Chat");
		setGoal({ enabled: true, goal: { status: "active", tokensUsed: 0 } });
		for (const shape of ["box", "band"]) {
			const editor = makeEditor();
			editor.setBorderStyle(shape);
			status.attachToEditor(editor, getComposerStyle(shape));
			for (const width of [30, 60, 100]) {
				const top = plain(editor.render(width)[0]);
				expect(visibleWidth(top)).toBe(width);
				expect(top).toMatch(/\(goal active\)[─ ]+Chat /);
				if (shape === "box") {
					expect(top).toStartWith("╭");
					expect(top).toEndWith("╮");
				}
			}
		}
	});

	it("does not wrap or partially draw the indicator at narrow widths", () => {
		const { status, setGoal } = fixture();
		setGoal({ enabled: true, goal: { status: "active", tokensUsed: 0 } });
		for (const width of [1, 8, 13, 14, 24, 40, 80]) {
			const line = plain(status.renderBottomBar(width, "full"));
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			if (width >= 14) expect(line).toEndWith("(goal active)");
			else expect(line).not.toContain("goal");
		}
	});
});
