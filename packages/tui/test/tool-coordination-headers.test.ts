import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { askToolRenderer } from "@oh-my-pi/pi-tui/tools/ask";
import { describeCfgWrite } from "@oh-my-pi/pi-tui/tools/cfg-render";

const ui: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

function render(
	tool: string,
	args: Record<string, unknown>,
	text: string,
	details?: unknown,
	partial = false,
): string[] {
	const card = new ToolExecutionComponent(tool, args, {}, undefined, ui, "/tmp");
	try {
		card.updateResult({ content: [{ type: "text", text }], details }, partial);
		return card.render(220).map(line => Bun.stripANSI(line));
	} finally {
		card.seal();
	}
}

const phases = [
	{
		name: "Release",
		tasks: [
			{ content: "Review headers", status: "completed" },
			{ content: "Install", status: "in_progress" },
			{ content: "Deploy", status: "blocked", blocker: "Awaiting approval" },
			{ content: "Old approach", status: "abandoned" },
		],
	},
];

describe("coordination headers use operation, identity and observed outcomes", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it.each(["done", "block", "unblock", "rm", "drop"])("keeps the affected task for todo %s", op => {
		const rows = render("todo", { op, task: "Review headers" }, "Awaiting approval", {
			op,
			phases,
			storage: "session",
		});
		expect(rows[0]).toContain(`${op} Review headers`);
		expect(rows[0]).toContain("1/4 completed");
		expect(rows[0]).toContain("1 blocked");
		expect(rows[0]).toContain("1 dropped");
		expect(rows[0]).not.toContain("Install");
		expect(rows.slice(1).join("\n")).toContain("Awaiting approval");
	});

	it("distinguishes todo view and preserves empty-snapshot notices", () => {
		const rows = render("todo", { op: "view" }, "Snapshot not mirrored", {
			op: "view",
			phases: [],
			storage: "session",
		});
		expect(rows[0]).toContain("view");
		expect(rows[0]).toContain("0/0 completed");
		expect(rows.slice(1).join("\n")).toContain("Snapshot not mirrored");
	});

	it("counts todo additions separately from completed transitions", () => {
		const appended = render("todo", { op: "append", phase: "Release", items: ["Verify", "Publish"] }, "Added tasks", {
			op: "append",
			phases,
			storage: "session",
		});
		expect(appended[0]).toContain("append Release 2 tasks");
		const completed = render("todo", { op: "done", task: "Review headers" }, "Completed", {
			op: "done",
			phases,
			storage: "session",
			completedTasks: [{ phase: "Release", content: "Review headers" }],
		});
		expect(completed[0]).toContain("+1 completed");
		expect(completed[0]).toContain("1/4 completed");
	});

	it("shows wait identities and counts without hiding completed work", () => {
		const rows = render("wait", {}, "Finding: preserve the approval warning", {
			op: "wait",
			jobs: [
				{
					id: "Reviewer",
					type: "task",
					label: "Review",
					status: "completed",
					durationMs: 1000,
					resultText: "Finding: preserve the approval warning",
				},
				{ id: "Build", type: "bash", label: "Build", status: "running", durationMs: 2000 },
			],
		});
		expect(rows[0]).toContain("Reviewer, Build");
		expect(rows[0]).toContain("1 running");
		expect(rows[0]).toContain("1 done");
		expect(rows.slice(1).join("\n")).toContain("preserve the approval warning");
	});

	it.each(["A service finished. Read proc://", "Wait limit reached; jobs are still running"])(
		"retains wait notice %s",
		notice => {
			const rows = render("wait", {}, notice, { op: "wait", jobs: [] });
			expect(rows.slice(1).join("\n")).toContain(notice);
		},
	);

	it("distinguishes timed-out answers and keeps selections", () => {
		const details = {
			results: [
				{
					id: "deploy",
					question: "Deploy now?",
					options: ["Wait"],
					selectedOptions: ["Wait"],
					multi: false,
					timedOut: true,
				},
				{ id: "region", question: "Region?", options: ["West"], selectedOptions: ["West"], multi: false },
			],
		};
		const rows = render("ask", { questions: [] }, "Wait (auto-selected); West", details);
		expect(rows[0]).toContain("Deploy now?");
		expect(rows[0]).toContain("1 answered");
		expect(rows[0]).toContain("1 auto-selected after timeout");
		expect(rows.slice(1).join("\n")).toContain("West");
		const native = askToolRenderer.describeResult({ content: [], details });
		expect(JSON.stringify(native?.body)).toContain("not a user choice");
	});

	it("keeps continued ask assumptions and pending answer state distinct", () => {
		const rows = render("ask", {}, "Assuming Wait; still open", {
			continued: {
				jobId: "answer",
				askedAt: 0,
				afterMs: 30000,
				assumptions: [{ id: "deploy", question: "Deploy now?", assumed: "Wait" }],
			},
		});
		expect(rows[0]).toContain("Deploy now?");
		expect(rows[0]).toContain("continuing");
		expect(rows[0]).not.toContain("answered");
		expect(rows.slice(1).join("\n")).toContain("still open");
	});

	it("uses the actual goal lifecycle and preserves budget reports", () => {
		const rows = render("goal", { op: "complete" }, "Budget report: work remains", {
			op: "complete",
			goal: {
				id: "goal",
				objective: "Ship headers",
				status: "budget-limited",
				tokenBudget: 50000,
				tokensUsed: 50000,
				timeUsedSeconds: 20,
				createdAt: 0,
				updatedAt: 0,
			},
			completionBudgetReport: "Budget report: work remains",
		});
		expect(rows[0]).toContain("Ship headers");
		expect(rows[0]).toContain("budget-limited");
		expect(rows[0]).not.toContain("complete");
		expect(rows.slice(1).join("\n")).toContain("work remains");
	});

	it("retains broadcast target and partial delivery errors", () => {
		const rows = render("write", { path: "agent://all", content: "Review" }, "Second: session unavailable", {
			message: {
				op: "send",
				to: "all",
				receipts: [
					{ to: "First", outcome: "injected" },
					{ to: "Second", outcome: "failed", error: "session unavailable" },
				],
			},
		});
		expect(rows[0]).toContain("IRC");
		expect(rows[0]).toContain("all");
		expect(rows[0]).toContain("1 delivered");
		expect(rows[0]).toContain("1 failed");
		expect(rows.slice(1).join("\n")).toContain("session unavailable");
	});

	it("does not infer cancellation from a kill request", () => {
		const rows = render("write", { path: "proc://Build/kill" }, "Build already completed", {
			proc: {
				op: "cancel",
				cancelled: [{ id: "Build", status: "already_completed", message: "Build already completed" }],
			},
		});
		expect(rows[0]).toContain("stop Build");
		expect(rows[0]).toContain("already completed");
		expect(rows[0]).not.toContain("cancelled");
	});

	it("keeps actionable config instructions in native results", () => {
		const result = { content: [{ type: "text", text: "User declined. NEVER retry unless asked." }] };
		const details = {
			path: "tier.openai",
			save: true,
			previous: "priority",
			value: "ultrafast",
			outcome: "declined" as const,
		};
		const native = describeCfgWrite("cfg://tier/openai/save", "ultrafast", result, details);
		expect(JSON.stringify(native.body)).toContain("NEVER retry");
		const rows = render("write", { path: "cfg://tier/openai/save" }, result.content[0]!.text, { cfg: details });
		expect(rows[0]).toContain("set tier.openai");
		expect(rows[0]).toContain("persist · declined");
		expect(rows[0]).not.toContain("applied");
	});
});
