import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";

const ESC = String.fromCharCode(27);
// SGR press/release click pairs, motion, and wheel reports on viewport rows.
const EXPANDER_PRESS = `${ESC}[<0;5;3M`;
const EXPANDER_RELEASE = `${ESC}[<0;5;3m`;
const EXPANDER_CLICK = EXPANDER_PRESS + EXPANDER_RELEASE;
const VIEWPORT_MOTION = `${ESC}[<35;5;3M`;
const VIEWPORT_WHEEL_UP = `${ESC}[<64;5;3M`;
const VIEWPORT_WHEEL_DOWN = `${ESC}[<65;5;3M`;

function makeHarness(
	options: {
		top?: number;
		tool?: (index: number) => string | undefined;
		candidates?: (index: number) => string[];
	} = {},
) {
	// These routing fixtures deliberately opt in; production keeps native wheel
	// scrolling and text selection unless the user enables click capture.
	cfgTuiMouse.set(settings, true);
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	const toolToggles: string[] = [];
	let toggled = 0;
	let renders = 0;
	let overlay = false;
	let mouseGeneration = 0;
	const ctx = {
		ui: {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => ({ top: options.top ?? 0, length: 5 }),
			hasOverlay: () => overlay,
			getMouseInputGeneration: () => mouseGeneration,
			requestRender: () => {
				renders++;
			},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		handlesBtwBranchKey: () => false,
		editor: {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		keybindings: KeybindingsManager.inMemory(),
		settings,
		dictationSpaceHold: () => undefined,
		session: {
			extensionRunner: undefined,
		},
		hideToolActivity: true,
		resolveViewportClickCandidates: (index: number) =>
			options.candidates?.(index) ?? (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
		resolveViewportClickTool: (index: number) => options.tool?.(index),
		toggleViewportTool: (id: string) => {
			toolToggles.push(id);
			return true;
		},
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	const input = (data: string) => {
		let current = data;
		let transformed = false;
		for (const listener of listeners) {
			const result = listener(current);
			if (result?.consume) return result;
			if (result?.data !== undefined) {
				current = result.data;
				transformed = true;
			}
		}
		return transformed ? { data: current } : undefined;
	};
	return {
		input,
		setOverlay: (visible: boolean) => {
			if (overlay !== visible) mouseGeneration++;
			overlay = visible;
		},
		setCapture: (enabled: boolean) => {
			if (cfgTuiMouse.get(settings) !== enabled) mouseGeneration++;
			cfgTuiMouse.set(settings, enabled);
		},
		click: () => input(EXPANDER_CLICK),
		motion: () => input(VIEWPORT_MOTION),
		wheel: (direction: "up" | "down") => input(direction === "up" ? VIEWPORT_WHEEL_UP : VIEWPORT_WHEEL_DOWN),
		renders: () => renders,
		focused,
		toggled: () => toggled,
		toolToggles,
	};
}

describe("InputController click routing", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("defaults to native scrolling and selection with mouse capture disabled", () => {
		expect(cfgTuiMouse.get(settings)).toBe(false);
	});

	it("focuses a live agent whose id equals the toggle sentinel", () => {
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "evil",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click();
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles when no live agent matches the sentinel", () => {
		const h = makeHarness();
		h.click();
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});

	it("activates exactly once on matching release, never on press or duplicate release", () => {
		const h = makeHarness();
		expect(h.input(EXPANDER_PRESS)).toEqual({ consume: true });
		expect(h.toggled()).toBe(0);
		expect(h.input(EXPANDER_RELEASE)).toEqual({ consume: true });
		expect(h.toggled()).toBe(1);
		h.input(EXPANDER_RELEASE);
		expect(h.toggled()).toBe(1);
	});

	it("cancels drags, motion, wheel, and mismatched releases", () => {
		for (const interruption of [
			`${ESC}[<32;6;3M`, // left-button drag
			`${ESC}[<32;5;3M`, // motion at the original cell is still a drag
			VIEWPORT_MOTION,
			VIEWPORT_WHEEL_UP,
			VIEWPORT_WHEEL_DOWN,
			`${ESC}[<66;5;3M`, // horizontal wheel
			`${ESC}[<0;6;3m`, // different column
			`${ESC}[<0;5;4m`, // different row
			`${ESC}[<2;5;3m`, // different button
			`${ESC}[<4;5;3m`, // different modifiers
		]) {
			const h = makeHarness();
			h.input(EXPANDER_PRESS);
			h.input(interruption);
			h.input(EXPANDER_RELEASE);
			expect(h.toggled()).toBe(0);
			expect(h.focused).toEqual([]);
			expect(h.toolToggles).toEqual([]);
		}
	});

	it("does not toggle a tool that replaces the pressed target", () => {
		let tool: string | undefined = "original";
		const h = makeHarness({ candidates: () => [], tool: () => tool });
		h.input(EXPANDER_PRESS);
		tool = "replacement";
		h.input(EXPANDER_RELEASE);
		expect(h.toolToggles).toEqual([]);
		h.input(EXPANDER_PRESS);
		tool = undefined;
		h.input(EXPANDER_RELEASE);
		expect(h.toolToggles).toEqual([]);
		h.input(EXPANDER_PRESS); // empty row cannot acquire a target on release
		tool = "replacement";
		h.input(EXPANDER_RELEASE);
		expect(h.toolToggles).toEqual([]);
		h.input(`${EXPANDER_PRESS}${ESC}[<32;6;3M${EXPANDER_RELEASE}`);
		expect(h.toolToggles).toEqual([]);
		h.click();
		expect(h.toolToggles).toEqual(["replacement"]);
	});

	it("does not focus a live agent that replaces the pressed HUD target", () => {
		const h = makeHarness();
		h.input(EXPANDER_PRESS);
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "replacement",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		h.input(EXPANDER_RELEASE);
		expect(h.focused).toEqual([]);
		expect(h.toggled()).toBe(0);
	});

	it("cancels pending clicks on typing, including text coalesced with mouse reports", () => {
		const h = makeHarness();
		h.input(EXPANDER_PRESS);
		expect(h.input("every character")).toBeUndefined();
		h.input(EXPANDER_RELEASE);
		expect(h.input(`${EXPANDER_PRESS}all the text${EXPANDER_RELEASE}after`)).toEqual({
			data: "all the textafter",
		});
		expect(h.toggled()).toBe(0);
	});

	it("cancels before a shortcut listener consumes keyboard input", () => {
		const h = makeHarness();
		// Ctrl+O is consumed by the global tool-expansion listener.
		h.input(EXPANDER_PRESS);
		h.input("\x0f");
		h.input(EXPANDER_RELEASE);
		expect(h.toggled()).toBe(0);
	});

	it("cancels pending clicks for pasted mouse-looking text without altering the paste", () => {
		const h = makeHarness();
		h.input(EXPANDER_PRESS);
		const paste = `${ESC}[200~first\n${EXPANDER_CLICK}\nlast${ESC}[201~`;
		expect(h.input(paste)).toBeUndefined();
		h.input(EXPANDER_RELEASE);
		expect(h.toggled()).toBe(0);
	});

	it("forgets pending clicks while capture is disabled or an overlay owns input", () => {
		const h = makeHarness();
		h.input(EXPANDER_PRESS);
		cfgTuiMouse.set(settings, false);
		expect(h.input(EXPANDER_RELEASE)).toBeUndefined();
		cfgTuiMouse.set(settings, true);
		h.input(EXPANDER_RELEASE);
		h.input(EXPANDER_PRESS);
		h.setOverlay(true);
		expect(h.input(EXPANDER_RELEASE)).toBeUndefined();
		h.setOverlay(false);
		h.input(EXPANDER_RELEASE);
		expect(h.toggled()).toBe(0);
	});

	it("rejects release after capture or overlay ownership cycles without intervening input", () => {
		const h = makeHarness();
		h.input(EXPANDER_PRESS);
		h.setCapture(false);
		h.setCapture(true);
		h.input(EXPANDER_RELEASE);
		expect(h.toggled()).toBe(0);
		h.input(EXPANDER_PRESS);
		h.setOverlay(true);
		h.setOverlay(false);
		h.input(EXPANDER_RELEASE);
		expect(h.toggled()).toBe(0);
		h.click();
		expect(h.toggled()).toBe(1);
	});

	it("keeps captured mouse protocol out of the editor without pretending to scroll native history", () => {
		const h = makeHarness();
		const renders = h.renders();
		expect(h.motion()).toEqual({ consume: true });
		expect(h.wheel("up")).toEqual({ consume: true });
		expect(h.wheel("down")).toEqual({ consume: true });
		expect(h.renders()).toBe(renders);
		expect(h.toggled()).toBe(0);
		expect(h.focused).toEqual([]);
		expect(h.toolToggles).toEqual([]);
		expect(h.click()).toEqual({ consume: true });
	});

	it("preserves typing coalesced before, between, and after reports", () => {
		const h = makeHarness();
		expect(h.input(`before${EXPANDER_CLICK}middle${VIEWPORT_WHEEL_UP}after`)).toEqual({
			data: "beforemiddleafter",
		});
		expect(h.toggled()).toBe(1);
		expect(h.input("more typing")).toBeUndefined();
	});

	it("does not retain plain text after a click while waiting for an m or M", () => {
		const h = makeHarness();
		expect(h.input(`${EXPANDER_CLICK}hello`)).toEqual({ data: "hello" });
		expect(h.input("world")).toBeUndefined();
		expect(h.input("mM")).toBeUndefined();
		expect(h.toggled()).toBe(1);
	});

	it("reassembles reports split after their unambiguous mouse prefix", () => {
		for (const report of [EXPANDER_PRESS, EXPANDER_RELEASE, VIEWPORT_WHEEL_UP, VIEWPORT_WHEEL_DOWN]) {
			for (let split = 3; split < report.length; split++) {
				const h = makeHarness();
				if (report === EXPANDER_RELEASE) h.input(EXPANDER_PRESS);
				expect(h.input(report.slice(0, split))).toEqual({ consume: true });
				expect(h.input(report.slice(split))).toEqual({ consume: true });
				if (report === EXPANDER_PRESS) h.input(EXPANDER_RELEASE);
				expect(h.input("typed")).toBeUndefined();
				expect(h.toggled()).toBe(report === EXPANDER_PRESS || report === EXPANDER_RELEASE ? 1 : 0);
			}
		}
	});

	it("reassembles one-byte report tails and keeps adjacent reports separate", () => {
		const h = makeHarness();
		expect(h.input(`${EXPANDER_CLICK}text${ESC}[<`)).toEqual({ data: "text" });
		for (const char of "65;5;3M") expect(h.input(char)).toEqual({ consume: true });
		expect(h.input("after")).toBeUndefined();
		expect(h.toggled()).toBe(1);
	});

	it("releases malformed partial reports without losing their following text", () => {
		const h = makeHarness();
		expect(h.input(`${ESC}[<0;`)).toEqual({ consume: true });
		expect(h.input("hello M")).toEqual({ data: `${ESC}[<0;hello M` });
		expect(h.input("typing")).toBeUndefined();
		expect(h.input(`${ESC}[<;5;3M${EXPANDER_CLICK}end`)).toEqual({ data: `${ESC}[<;5;3Mend` });
		expect(h.toggled()).toBe(1);
	});

	it("leaves ambiguous Escape prefixes and bracketed paste to terminal framing", () => {
		const h = makeHarness();
		expect(h.input(ESC)).toBeUndefined();
		expect(h.input(`${ESC}[`)).toBeUndefined();
		expect(h.input(`${ESC}[200~${EXPANDER_CLICK}${ESC}[201~`)).toBeUndefined();
		expect(h.toggled()).toBe(0);
	});

	it("consumes releases and horizontal wheel reports without activating click targets", () => {
		const h = makeHarness();
		expect(h.input(`${ESC}[<0;5;3m${ESC}[<66;5;3M${ESC}[<67;5;3Mtyped`)).toEqual({ data: "typed" });
		expect(h.toggled()).toBe(0);
		expect(h.focused).toEqual([]);
		expect(h.toolToggles).toEqual([]);
	});

	it("forgets partial reports when capture is disabled or an overlay takes ownership", () => {
		const h = makeHarness();
		expect(h.input(`${ESC}[<0;`)).toEqual({ consume: true });
		cfgTuiMouse.set(settings, false);
		expect(h.input("typing")).toBeUndefined();
		cfgTuiMouse.set(settings, true);
		expect(h.input("5;3M")).toBeUndefined();
		expect(h.input(`${ESC}[<0;`)).toEqual({ consume: true });
		h.setOverlay(true);
		expect(h.click()).toBeUndefined();
		h.setOverlay(false);
		expect(h.input("5;3M")).toBeUndefined();
		expect(h.toggled()).toBe(0);
	});

	it("routes a retired row above the viewport to its tool block", () => {
		// Screen row 2 sits two rows above a viewport that starts at row 4.
		const h = makeHarness({ top: 4, tool: index => (index === -2 ? "tool-1" : undefined) });
		expect(h.click()).toEqual({ consume: true });
		expect(h.toolToggles).toEqual(["tool-1"]);
		expect(h.toggled()).toBe(0);
	});

	it("ignores motion over retired tool rows without repainting or toggling", () => {
		const h = makeHarness({ top: 4, tool: index => (index === -2 ? "tool-1" : undefined) });
		const renders = h.renders();
		expect(h.motion()).toEqual({ consume: true });
		expect(h.renders()).toBe(renders);
		expect(h.toolToggles).toEqual([]);
		expect(h.focused).toEqual([]);
	});
});
