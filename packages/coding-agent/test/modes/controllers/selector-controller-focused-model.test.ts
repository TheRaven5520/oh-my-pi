/**
 * Model switches made while a subagent is focused belong to that subagent's
 * session. Failure mode if this regresses: alt+m, /model or the alt+p picker in
 * a subagent's view silently re-models the main session (or edits global role
 * defaults), and an over-context pick compacts the main transcript.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import * as modelPickerModule from "@oh-my-pi/pi-tui/overlays/model-picker";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const BIG = { provider: "sprilicred-openai", id: "gpt-big", contextWindow: 400_000 } as Model;
const SMALL = { provider: "sprilicred-openai", id: "gpt-small", contextWindow: 1_000 } as Model;

function sessionStub(tokens: number) {
	return {
		model: BIG,
		scopedModels: [],
		getContextUsage: () => ({ tokens }),
		getRoleModelCycle: () => undefined,
		resolveTemporaryModelThinkingLevel: () => undefined,
		setModelTemporary: vi.fn(async () => {}),
	};
}

function focusedController(tokens: number) {
	const main = sessionStub(tokens);
	const worker = sessionStub(tokens);
	const showStatus = vi.fn();
	const showError = vi.fn();
	const handleCompactCommand = vi.fn(async () => "ok" as const);
	const controller = new SelectorController(
		createInteractiveModeContext({
			session: main as never,
			viewSession: worker as never,
			focusedAgentId: "Worker",
			ui: { showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }) },
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showStatus,
			showError,
			handleCompactCommand,
		}),
	);
	return { controller, main, worker, showStatus, showError, handleCompactCommand };
}

function capturePicker(): () => modelPickerModule.ModelPickerCallbacks {
	let callbacks: modelPickerModule.ModelPickerCallbacks | undefined;
	vi.spyOn(modelPickerModule, "ModelPickerComponent").mockImplementation(function (...args: unknown[]) {
		callbacks = args[4] as modelPickerModule.ModelPickerCallbacks;
		return {};
	} as never);
	return () => {
		if (!callbacks) throw new Error("model picker was not opened");
		return callbacks;
	};
}

describe("SelectorController in a focused subagent view", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("opens the session picker for /model and switches the focused agent, not main", async () => {
		const h = focusedController(10);
		const hub = vi.spyOn(modelHubModule, "ModelHubComponent");
		const picker = capturePicker();

		h.controller.showModelSelector();
		await Promise.resolve(picker().onPick(SMALL, "sprilicred-openai/gpt-small", { overContext: false }));

		expect(hub).not.toHaveBeenCalled();
		expect(h.worker.setModelTemporary).toHaveBeenCalledWith(SMALL, undefined);
		expect(h.main.setModelTemporary).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("Agent Worker model: sprilicred-openai/gpt-small (this agent only).");
	});

	it("refuses an over-context switch without compacting the main session", async () => {
		const h = focusedController(5_000);

		await h.controller.switchSessionModel(SMALL);

		expect(h.handleCompactCommand).not.toHaveBeenCalled();
		expect(h.worker.setModelTemporary).not.toHaveBeenCalled();
		expect(h.main.setModelTemporary).not.toHaveBeenCalled();
		expect(h.showError).toHaveBeenCalledWith(
			"sprilicred-openai/gpt-small can't fit agent Worker's 5,000-token transcript; it keeps its current model",
		);
	});
});
