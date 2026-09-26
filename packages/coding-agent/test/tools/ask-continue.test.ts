import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";

const QUESTION = {
	id: "db",
	question: "Which database?",
	options: [{ label: "SQLite" }, { label: "Postgres" }],
	recommended: 1,
};

/** A rich ask dialog the test answers by hand, recording what the tool asked of it. */
function fakeDialog() {
	const answer = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
	let options: ExtensionUIDialogOptions | undefined;
	const askDialog = vi.fn((_questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions) => {
		options = dialogOptions;
		dialogOptions?.signal?.addEventListener("abort", () => answer.resolve(undefined), { once: true });
		return answer.promise;
	});
	return {
		askDialog,
		options: () => options,
		present: () => options?.onPresented?.(),
		answer: (result: ExtensionAskDialogResult | undefined) => answer.resolve(result),
	};
}

function setup(settings: Record<string, unknown>, opts: { planMode?: boolean; presentOnShow?: boolean } = {}) {
	const manager = new AsyncJobManager({});
	const delivered: Array<{ jobId: string; text: string }> = [];
	manager.registerDeliverySink("Main", (jobId, text) => {
		delivered.push({ jobId, text });
	});
	const session = {
		cwd: "/tmp/test",
		hasUI: true,
		canPromptUser: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "ask.notify": "off", "speech.enabled": false, ...settings }),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getPlanModeState: () => ({ enabled: opts.planMode === true }),
	} as unknown as ToolSession;
	const dialog = fakeDialog();
	const abort = vi.fn();
	const context = {
		hasUI: true,
		ui: {
			askDialog: dialog.askDialog,
			editor: vi.fn(),
			// The TUI starts countdowns when the dialog is on screen.
			timeoutStartsOnPresentation: opts.presentOnShow !== false,
		},
		abort,
	} as unknown as AgentToolContext;
	return { tool: new AskTool(session), manager, delivered, dialog, abort, context };
}

const submit = (selected: string): ExtensionAskDialogResult => ({
	kind: "submit",
	results: [
		{
			id: "db",
			question: QUESTION.question,
			options: ["SQLite", "Postgres"],
			multi: false,
			selectedOptions: [selected],
		},
	],
});

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ask.continueAfter", () => {
	it("continues on the recommended option once the question has been on screen that long, then delivers the late answer", async () => {
		vi.useFakeTimers();
		const { tool, manager, delivered, dialog, context } = setup({ "ask.continueAfter": 300 });
		const call = tool.execute("call-1", { questions: [QUESTION] }, undefined, undefined, context);
		await Promise.resolve();
		// Waiting behind another dialog does not count toward the five minutes.
		vi.advanceTimersByTime(600_000);
		dialog.present();
		vi.advanceTimersByTime(299_000);
		let settled = false;
		void call.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		vi.advanceTimersByTime(1_000);
		const result = await call;

		const details = result.details as AskToolDetails;
		expect(details.continued?.assumptions).toEqual([{ id: "db", question: "Which database?", assumed: "Postgres" }]);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain('assume "Postgres"');
		expect(text).toContain("Do not wait or poll");
		// The question stays open, and yields to any other prompt from now on.
		expect(dialog.options()?.signal?.aborted).toBe(false);
		expect(dialog.options()?.yieldSignal?.aborted).toBe(true);
		const jobId = details.continued!.jobId;
		expect(manager.getRunningJobs().map(job => job.id)).toEqual([jobId]);
		// Nothing may wait on the user.
		expect(manager.getRunningWorkJobs()).toEqual([]);

		vi.useRealTimers();
		dialog.answer(submit("SQLite"));
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.jobId).toBe(jobId);
		expect(delivered[0]!.text).toContain('"Postgres"');
		expect(delivered[0]!.text).toContain("User selected: SQLite");
		expect(delivered[0]!.text).toContain("correct the work built on the assumption");
	});

	it("tells the agent to keep its assumption when the user dismisses the open question", async () => {
		vi.useFakeTimers();
		const { tool, manager, delivered, dialog, context, abort } = setup({ "ask.continueAfter": 60 });
		const call = tool.execute("call-2", { questions: [QUESTION] }, undefined, undefined, context);
		dialog.present();
		vi.advanceTimersByTime(60_000);
		await call;
		vi.useRealTimers();
		dialog.answer(undefined);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(delivered[0]!.text).toContain("dismissed");
		expect(delivered[0]!.text).toContain("Keep your assumption");
		// The finished turn is not aborted by a late dismissal.
		expect(abort).not.toHaveBeenCalled();
	});

	it("says there is no recommended option instead of naming one", async () => {
		vi.useFakeTimers();
		const { tool, dialog, context } = setup({ "ask.continueAfter": 60 });
		const call = tool.execute(
			"call-3",
			{ questions: [{ ...QUESTION, recommended: undefined }] },
			undefined,
			undefined,
			context,
		);
		dialog.present();
		vi.advanceTimersByTime(60_000);
		const result = await call;
		expect((result.details as AskToolDetails).continued?.assumptions[0]?.assumed).toBeUndefined();
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("no recommended option; use your best judgment");
	});

	it("returns an answer given in time exactly as before, with no job", async () => {
		const { tool, manager, dialog, context } = setup({ "ask.continueAfter": 300 });
		const call = tool.execute("call-4", { questions: [QUESTION] }, undefined, undefined, context);
		dialog.present();
		dialog.answer(submit("SQLite"));
		const result = await call;
		expect((result.details as AskToolDetails).selectedOptions).toEqual(["SQLite"]);
		expect((result.details as AskToolDetails).continued).toBeUndefined();
		expect(manager.getAllJobs()).toEqual([]);
		// The dialog is closed once the call returns.
		expect(dialog.options()?.signal?.aborted).toBe(true);
	});

	it("keeps waiting in plan mode, and does not auto-select either", async () => {
		vi.useFakeTimers();
		const { tool, manager, dialog, context } = setup(
			{ "ask.continueAfter": 60, "ask.timeout": 30 },
			{ planMode: true },
		);
		const call = tool.execute("call-5", { questions: [QUESTION] }, undefined, undefined, context);
		dialog.present();
		vi.advanceTimersByTime(3_600_000);
		expect(dialog.options()?.timeout).toBeUndefined();
		expect(manager.getAllJobs()).toEqual([]);
		vi.useRealTimers();
		dialog.answer(submit("SQLite"));
		expect(((await call).details as AskToolDetails).selectedOptions).toEqual(["SQLite"]);
	});

	it("replaces the auto-select timeout, so the question stays answerable", async () => {
		const { tool, dialog, context } = setup({ "ask.continueAfter": 300, "ask.timeout": 30 });
		const call = tool.execute("call-6", { questions: [QUESTION] }, undefined, undefined, context);
		expect(dialog.options()?.timeout).toBeUndefined();
		dialog.answer(submit("SQLite"));
		await call;
	});

	it("still aborts the turn when the user cancels before the deadline", async () => {
		const { tool, dialog, context, abort } = setup({ "ask.continueAfter": 300 });
		const call = tool.execute("call-7", { questions: [QUESTION] }, undefined, undefined, context);
		dialog.present();
		dialog.answer(undefined);
		await expect(call).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("closes the open question when its job is cancelled", async () => {
		vi.useFakeTimers();
		const { tool, manager, delivered, dialog, context } = setup({ "ask.continueAfter": 60 });
		const call = tool.execute("call-8", { questions: [QUESTION] }, undefined, undefined, context);
		dialog.present();
		vi.advanceTimersByTime(60_000);
		const jobId = ((await call).details as AskToolDetails).continued!.jobId;
		vi.useRealTimers();

		expect(manager.cancel(jobId)).toBe(true);
		expect(dialog.options()?.signal?.aborted).toBe(true);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 200 });
		expect(delivered).toEqual([]);
	});

	it("keeps waiting inline when no background job can be started", async () => {
		vi.useFakeTimers();
		const { tool, manager, dialog, context } = setup({ "ask.continueAfter": 60 });
		vi.spyOn(manager, "register").mockImplementation(() => {
			throw new Error("Background job limit reached (1).");
		});
		const call = tool.execute("call-9", { questions: [QUESTION] }, undefined, undefined, context);
		dialog.present();
		vi.advanceTimersByTime(60_000);
		await Promise.resolve();
		vi.useRealTimers();
		dialog.answer(submit("SQLite"));
		expect(((await call).details as AskToolDetails).selectedOptions).toEqual(["SQLite"]);
		expect(dialog.options()?.signal?.aborted).toBe(true);
	});

	it("keeps the open question when the turn it came from is aborted afterwards", async () => {
		vi.useFakeTimers();
		const { tool, manager, delivered, dialog, context } = setup({ "ask.continueAfter": 60 });
		const turn = new AbortController();
		const call = tool.execute("call-10", { questions: [QUESTION] }, turn.signal, undefined, context);
		dialog.present();
		vi.advanceTimersByTime(60_000);
		await call;
		vi.useRealTimers();
		// Esc or a steer ends that turn; the question it left behind stays open.
		turn.abort();
		expect(dialog.options()?.signal?.aborted).toBe(false);
		dialog.answer(submit("SQLite"));
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(delivered[0]!.text).toContain("User selected: SQLite");
	});

	it("closes the question when the turn is aborted before the deadline", async () => {
		const { tool, manager, dialog, context } = setup({ "ask.continueAfter": 60 });
		const turn = new AbortController();
		const call = tool.execute("call-11", { questions: [QUESTION] }, turn.signal, undefined, context);
		dialog.present();
		turn.abort();
		await expect(call).rejects.toBeInstanceOf(ToolAbortError);
		expect(dialog.options()?.signal?.aborted).toBe(true);
		expect(manager.getAllJobs()).toEqual([]);
	});
});
