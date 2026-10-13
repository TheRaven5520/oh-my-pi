import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const ui: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

function rows(
	tool: string,
	args: Record<string, unknown>,
	text: string,
	details?: unknown,
	partial = false,
	isError = false,
): string[] {
	const card = new ToolExecutionComponent(tool, args, {}, undefined, ui, "/tmp");
	try {
		card.updateResult({ content: [{ type: "text", text }], details, isError }, partial);
		return card.render(180).map(row => Bun.stripANSI(row));
	} finally {
		card.seal();
	}
}

function progress(id: string, index: number, extra: Partial<AgentProgress> = {}): AgentProgress {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Inspect receipts",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...extra,
	};
}

function taskDetails(...agents: AgentProgress[]): TaskToolDetails {
	return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: agents };
}

describe("structured status receipts in compact cards", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("puts a confirmed delivery in the head without a duplicate body", () => {
		const rendered = rows("write", { path: "agent://Reviewer", content: "Review this" }, "Delivered to Reviewer.", {
			message: { op: "send", to: "Reviewer", receipts: [{ to: "Reviewer", outcome: "injected" }] },
		});
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("Reviewer");
		expect(rendered[0]).toContain("1 delivered");
	});

	it("inlines successful broadcast receipts and their delivered count", () => {
		const rendered = rows(
			"write",
			{ path: "agent://all", content: "Review this" },
			"Broadcast delivered to 2 of 2 peer(s).\n- First: injected\n- Second: woken",
			{
				message: {
					op: "send",
					to: "all",
					receipts: [
						{ to: "First", outcome: "injected" },
						{ to: "Second", outcome: "woken" },
					],
				},
			},
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("2 delivered");
	});

	it("retains partial delivery errors, revived warnings and unrecognized extra text", () => {
		const partial = rows("write", { path: "agent://all" }, "Second: failed — session unavailable", {
			message: {
				op: "send",
				to: "all",
				receipts: [
					{ to: "First", outcome: "injected" },
					{ to: "Second", outcome: "failed", error: "session unavailable" },
				],
			},
		});
		expect(partial[0]).toContain("1 delivered");
		expect(partial[0]).toContain("1 failed");
		expect(partial.slice(1).join("\n")).toContain("session unavailable");
		const revived = rows("write", { path: "agent://First" }, "Queued for First (was parked; revived).", {
			message: { op: "send", to: "First", receipts: [{ to: "First", outcome: "revived" }] },
		});
		expect(revived.slice(1).join("\n")).toContain("was parked; revived");
		const extra = rows("write", { path: "agent://First" }, "Delivered to First.\nWarning: follow-up required", {
			message: { op: "send", to: "First", receipts: [{ to: "First", outcome: "injected" }] },
		});
		expect(extra.slice(1).join("\n")).toContain("follow-up required");
	});

	it("does not infer delivery from prose or partial results", () => {
		expect(rows("write", { path: "agent://First" }, "Delivered to First.").length).toBeGreaterThan(1);
		const rendered = rows(
			"write",
			{ path: "agent://First" },
			"Awaiting delivery",
			{
				message: { op: "send", to: "First", receipts: [{ to: "First", outcome: "injected" }] },
			},
			true,
		);
		expect(rendered[0]).not.toContain("delivered");
		expect(rendered.slice(1).join("\n")).toContain("Awaiting delivery");
	});

	it("inlines unambiguous cancellation but retains incomplete cancellation explanations", () => {
		const rendered = rows(
			"write",
			{ path: "proc://Worker/kill" },
			"Cancelled agent Worker (killed session, dropped registration).",
			{
				proc: { op: "cancel", jobs: [], cancelled: [{ id: "Worker", status: "cancelled" }] },
			},
		);
		expect(rendered).toHaveLength(1);
		const incomplete = rows(
			"write",
			{ path: "proc://Worker/kill" },
			"Worker could not be fully cancelled: timed out",
			{
				proc: { op: "cancel", jobs: [], cancelled: [{ id: "Worker", status: "already_completed" }] },
			},
		);
		expect(incomplete.slice(1).join("\n")).toContain("timed out");
	});

	it("keeps process details when structured state cannot represent the whole output", () => {
		const rendered = rows(
			"write",
			{ path: "proc://server/mode", content: "persist" },
			"server mode=persist; pid 123",
			{
				proc: {
					action: "mode",
					mode: "persist",
					daemon: { name: "server", state: "ready", startedAt: 0, persist: true, detached: false },
				},
			},
		);
		expect(rendered.slice(1).join("\n")).toContain("pid 123");
	});

	it.each(["applied", "unchanged", "declined"])("keeps actionable config text for %s outcomes", outcome => {
		const rendered = rows(
			"write",
			{ path: "cfg://tier/openai/save", content: "ultrafast" },
			"User approval and persistence details must remain visible.\nHigher-precedence layer still overrides this value.",
			{
				cfg: {
					path: "tier.openai",
					save: true,
					previous: "none",
					value: "ultrafast",
					outcome,
					effective: "priority",
				},
			},
		);
		expect(rendered[0]).toContain(`persist · ${outcome}`);
		expect(rendered.slice(1).join("\n")).toContain("User approval and persistence");
		expect(rendered.slice(1).join("\n")).toContain("Higher-precedence");
	});

	it("keeps settings approval failures visible without claiming success", () => {
		const rendered = rows(
			"write",
			{ path: "cfg://tier/openai" },
			"Changing settings requires user approval",
			undefined,
			false,
			true,
		);
		expect(rendered.join("\n")).toContain("requires user approval");
		expect(rendered[0]).not.toContain("applied");
	});

	it("shows the actual running roster without repeating the raw status body", () => {
		const rendered = rows(
			"task",
			{ tasks: [{ name: "Requested" }] },
			"Running agent Second...",
			taskDetails(progress("Second", 1), progress("First", 0)),
			true,
		);
		expect(rendered[0]).toContain("2 running");
		const content = rendered.join("\n");
		expect(content.indexOf("First")).toBeLessThan(content.indexOf("Second"));
		expect(content).toContain("First");
		expect(content).toContain("Second");
		expect(content).not.toContain("Running agent Second...");
		expect(rendered[0]).not.toContain("Requested");
	});

	it("retains real child progress and retry errors instead of replacing them with a roster", () => {
		const details = taskDetails(
			progress("First", 0, {
				recentOutput: ["Found actionable mismatch"],
				retryFailure: { attempt: 2, errorMessage: "Provider unavailable" },
			}),
		);
		const rendered = rows("task", {}, "Running agent First...", details, true);
		expect(rendered.slice(1).join("\n")).toContain("Found actionable mismatch");
		expect(rendered.slice(1).join("\n")).toContain("Provider unavailable");
		const output = rows("task", {}, "First: custom progress must survive", details, true);
		expect(output.slice(1).join("\n")).toContain("custom progress must survive");
	});

	it("does not hide completed task findings behind a done count", () => {
		const rendered = rows("task", {}, "Finding: fix the race before deployment", {
			projectAgentsDir: null,
			totalDurationMs: 1,
			results: [
				{
					id: "First",
					index: 0,
					exitCode: 0,
					agent: "task",
					agentSource: "bundled",
					task: "Inspect receipts",
					output: "Finding: fix the race before deployment",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: 0,
					requests: 0,
				},
			],
		});
		expect(rendered[0]).toContain("1 done");
		expect(rendered.slice(1).join("\n")).toContain("fix the race");
	});
});
