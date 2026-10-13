import { beforeAll, expect, it } from "bun:test";
import { Composer } from "../src/prompt/composer";
import { createStartupStatusLine } from "../src/status-line/startup";
import { initTheme } from "../src/theme/theme";
import type { TuiPaint } from "../src/tui";
import { Text } from "../src/components/text";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

it("identifies the actual final status row and reports completed physical geometry", async () => {
	const terminal = new VirtualTerminal(80, 20);
	const scheduler = new VirtualRenderScheduler();
	let paint: TuiPaint | undefined;
	class ObservedComposer extends Composer {
		override onTerminalPaint(value: TuiPaint): void {
			super.onTerminalPaint(value);
			paint = value;
		}
	}
	const composer = new ObservedComposer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: {
			quiet: true,
			spellingTypoDetection: false,
			spellingAutocomplete: "off",
			spellingAutocorrect: false,
		},
	});
	const status = createStartupStatusLine({
		settings: { leftSegments: ["path"], rightSegments: [] },
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
	status.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
	composer.setStatusComponent(status);
	let rows = ["short chat"];
	composer.setRuntimeChildren([{ render: () => rows }]);
	composer.start({ playWelcomeIntro: false });
	try {
		await scheduler.settle(terminal);
		expect(status.lastRenderEndsWithStatusLine).toBe(true);
		expect(paint!.viewportTop! + paint!.viewport.length).toBeLessThan(paint!.rows);

		rows = Array.from({ length: 30 }, (_, i) => `chat ${i}`);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		expect(status.lastRenderEndsWithStatusLine).toBe(true);
		expect(paint!.viewportTop! + paint!.viewport.length).toBe(paint!.rows);
		expect(paint!.alt).toBe(false);

		const overlay = composer.ui.showOverlay(new Text("full-screen overlay", 0, 0), { fullscreen: true });
		await scheduler.settle(terminal);
		expect(paint!.alt).toBe(true);
		overlay.hide();
		await scheduler.settle(terminal);
		expect(paint!.alt).toBe(false);

		status.setHookStatus("test", "hook below status");
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		expect(status.lastRenderEndsWithStatusLine).toBe(false);
		status.setHookStatus("test", undefined);
		status.setAutocompleteActiveProbe(() => true);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		expect(status.lastRenderEndsWithStatusLine).toBe(false);
	} finally {
		composer.stop();
		status.dispose();
	}
});
