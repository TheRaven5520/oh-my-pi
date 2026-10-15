import { beforeAll, expect, it } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

async function setup(draft = "", includeHud = false) {
	const terminal = new VirtualTerminal(80, 20);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: {
			quiet: true,
			composerShape: "pi",
			spellingAutocomplete: "off",
			spellingTypoDetection: false,
			spellingAutocorrect: false,
		},
	});
	const transcript = new TranscriptContainer();
	for (let index = 0; index < 80; index++) transcript.addChild(new Text(`Message ${index}`, 0, 0));
	const hud = { render: () => ["TODO HUD", "AGENTS HUD"] };
	composer.setRuntimeChildren([transcript, ...(includeHud ? [hud] : []), composer.editor], {
		transient: [composer.editor],
	});
	composer.editor.setText(draft);
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	const view = () => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	const wheel = async (direction: "up" | "down", count = 1) => {
		for (let i = 0; i < count; i++) terminal.sendInput(`\x1b[<${direction === "up" ? 64 : 65};4;4M`);
		await scheduler.settle(terminal);
	};
	return { terminal, scheduler, composer, transcript, view, wheel };
}

it("reveals a typed draft without moving the message being read, then hides only the empty composer", async () => {
	const { terminal, scheduler, composer, view, wheel } = await setup();
	try {
		await wheel("up", 8);
		const before = view();
		expect(composer.isViewportBrowsing()).toBe(true);
		expect(before.slice(0, -3).some(row => row.includes("─"))).toBe(false);
		terminal.sendInput("a draft while reading");
		await scheduler.settle(terminal);
		const typed = view();
		expect(typed.slice(0, 5)).toEqual(before.slice(0, 5));
		expect(typed.join("\n")).toContain("a draft while reading");
		expect(typed.slice(-5).join("\n")).toContain("a draft while reading");
		terminal.sendInput("\x03");
		await scheduler.settle(terminal);
		expect(composer.editor.getText()).toBe("");
		expect(view().slice(0, 5)).toEqual(before.slice(0, 5));
		expect(
			view()
				.slice(0, -3)
				.some(row => row.includes("─")),
		).toBe(false);
	} finally {
		composer.stop();
	}
});

it("does not pin todo and agent HUDs while browsing", async () => {
	const { composer, view, wheel } = await setup("", true);
	try {
		expect(view().join("\n")).toContain("TODO HUD");
		await wheel("up", 4);
		const browsed = view();
		expect(browsed.slice(-5).join("\n")).not.toContain("TODO HUD");
		expect(browsed.slice(-5).join("\n")).not.toContain("AGENTS HUD");
	} finally {
		composer.stop();
	}
});

it("keeps an existing multiline draft pinned while wheel gestures change only the transcript", async () => {
	const { composer, view, wheel } = await setup("first line\nsecond line");
	try {
		await wheel("up", 5);
		const first = view();
		await wheel("up", 3);
		const second = view();
		expect(second[0]).not.toEqual(first[0]);
		const composerTop = first.findIndex(row => row.includes("─"));
		expect(composerTop).toBeGreaterThan(0);
		expect(second.slice(composerTop)).toEqual(first.slice(composerTop));
		expect(second.slice(composerTop).join("\n")).toContain("second line");
		await wheel("down", 100);
		expect(composer.isViewportBrowsing()).toBe(false);
		expect(view().join("\n")).toContain("Message 79");
		expect(composer.editor.getText()).toBe("first line\nsecond line");
	} finally {
		composer.stop();
	}
});

it("holds the transcript anchor through paste, new output and draft deletion without clearing history per frame", async () => {
	const { terminal, scheduler, composer, transcript, view, wheel } = await setup();
	try {
		await wheel("up", 10);
		const anchor = view().slice(0, 4);
		const writes: string[] = [];
		const original = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			original(data);
		};
		terminal.sendInput("\x1b[200~pasted\nnotes\x1b[201~");
		await scheduler.settle(terminal);
		expect(view().slice(0, 4)).toEqual(anchor);
		transcript.addChild(new Text("New output while reading history", 0, 0));
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		expect(view().slice(0, 4)).toEqual(anchor);
		expect(composer.editor.getText()).toBe("pasted\nnotes");
		await wheel("up");
		expect(writes.join("")).not.toContain("\x1b[3J");
		expect(writes.join("")).not.toContain("\x1b[?1049h");
	} finally {
		composer.stop();
	}
});

it("moves by the wheel distance when an empty composer disappears", async () => {
	const { composer, view, wheel } = await setup();
	try {
		const before = view();
		await wheel("up");
		expect(view().slice(3, 9)).toEqual(before.slice(0, 6));
	} finally {
		composer.stop();
	}
});

it("keeps the same historical message and draft through a height resize", async () => {
	const { terminal, scheduler, composer, view, wheel } = await setup("kept draft");
	try {
		await wheel("up", 8);
		const top = view().slice(0, 3);
		terminal.resize(80, 15);
		await scheduler.advance(terminal, 500);
		expect(view().slice(0, 3)).toEqual(top);
		expect(view().slice(-5).join("\n")).toContain("kept draft");
		terminal.resize(80, 25);
		await scheduler.advance(terminal, 500);
		expect(view().slice(0, 3)).toEqual(top);
		expect(view().slice(-5).join("\n")).toContain("kept draft");
	} finally {
		composer.stop();
	}
});
