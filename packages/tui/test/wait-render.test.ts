/**
 * The job tool's TUI preview must not leak the model-facing `<task-result>`
 * envelope (prompts/tools/task-summary.md): a settled task job previews the
 * inner <output>/<preview> body, while non-envelope result text (bash jobs)
 * passes through unchanged.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../../coding-agent/src/prompts/tools/task-summary.md" with { type: "text" };
import { createIrcMessageCard, waitToolRenderer } from "@oh-my-pi/pi-tui/tools/wait";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

function renderLines(resultText: string): string {
	const result = {
		content: [{ type: "text", text: "" }],
		details: {
			op: "wait" as const,
			jobs: [
				{
					id: "SpawnProbe",
					type: "task" as const,
					status: "completed" as const,
					label: "SpawnProbe",
					durationMs: 8_700,
					resultText,
				},
			],
		},
	};
	const component = waitToolRenderer.renderResult(
		result,
		{ expanded: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
		theme,
	);
	return (component.render(120) as readonly string[]).join("\n");
}

describe("job renderer task-result preview", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the consumed peer message as a sender card", () => {
		const component = waitToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[42] Worker: file unlocked" }],
				details: {
					op: "wait",
					waited: { id: "42", from: "Worker", to: "Main", body: "file unlocked", ts: Date.now() },
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		const output = Bun.stripANSI(component.render(120).join("\n"));
		expect(output).toContain("Worker");
		expect(output).toContain("file unlocked");
	});

	it("renders a waited /fork report as a fork card with the whole report wrapped", () => {
		const body = `${"The fork checked every caller and found the leak in the session cache. ".repeat(3)}zebra`;
		const [report = "", ordinary = ""] = [{ done: true }, undefined].map(forkReport =>
			Bun.stripANSI(
				waitToolRenderer
					.renderResult(
						{
							content: [],
							details: {
								op: "wait",
								from: "Main",
								waited: { id: "m1", from: "Fork-1", to: "Main", body, ts: Date.now(), forkReport },
							},
						},
						{ expanded: false, isPartial: false },
						theme,
					)
					.render(60)
					.join("\n"),
			),
		);

		expect(report).toContain("Fork report");
		expect(report).toContain("zebra");
		expect(ordinary).toContain(`IRC ${theme.nav.back} Fork-1`);
		expect(ordinary).not.toContain("Fork report");
	});

	it("wraps a /fork report on a narrow card without dropping characters", () => {
		const card = createIrcMessageCard(
			{ kind: "incoming", from: "Fork-1", body: "abcdefghij klmnopqrst", forkReport: { done: true } },
			() => true,
			theme,
		);
		const lines = card.render(12) as readonly string[];
		// The title occupies the first line; the body must wrap to whole words.
		const body = lines.slice(1).map(line => Bun.stripANSI(line).trim());
		expect(body).toEqual(["abcdefghij", "klmnopqrst"]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
	});

	it("previews the envelope body, not the wrapper markup", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "SpawnProbe",
			status: "completed",
			duration: "8.7s",
			preview: "Probe finished: spawned worker, ping ok.",
			truncated: false,
			meta: { lineCount: 3, charSize: "120 B" },
			mergeSummary: "",
		});
		const deliveryText = `${summary}\n\nSpawnProbe is now idle — message it via \`write agent://SpawnProbe\` to follow up; transcript at history://SpawnProbe`;

		const output = renderLines(deliveryText);
		expect(output).toContain("Probe finished: spawned worker, ping ok.");
		expect(output).not.toContain("<task-result");
		expect(output).not.toContain("<output>");
	});

	it("previews the truncated <preview> body the same way", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "task",
			id: "BigOne",
			status: "completed",
			duration: "2m",
			preview: "first line of long output",
			truncated: true,
			mergeSummary: "",
		});

		const output = renderLines(summary);
		expect(output).toContain("first line of long output");
		expect(output).not.toContain("<task-result");
	});

	it("flattens a pretty-printed JSON body instead of previewing a lone brace", () => {
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: "sonic",
			id: "EchoAlpha",
			status: "completed",
			duration: "11.6s",
			preview: '{\n  "echo": "alpha",\n  "ok": true\n}',
			truncated: false,
			mergeSummary: "",
		});

		const output = Bun.stripANSI(renderLines(summary));
		expect(output).toContain('{ "echo": "alpha", "ok": true }');
		expect(output.split("\n").some(line => line.trim() === "{")).toBe(false);
	});

	it("passes non-envelope result text through unchanged", () => {
		const output = renderLines("42 pass, 0 fail (18.4s)");
		expect(output).toContain("42 pass, 0 fail (18.4s)");
	});

	it("drops the id column when the label repeats it", () => {
		// Task jobs label themselves with their agent id; rendering both columns
		// stutters ("SpawnProbe ⟨task⟩ SpawnProbe").
		const output = Bun.stripANSI(renderLines("done"));
		const header = output.split("\n").find(line => line.includes("SpawnProbe"));
		expect(header).toBeDefined();
		expect(header!.match(/SpawnProbe/g)).toHaveLength(1);
	});

	describe("collapse and filter when turned into a result", () => {
		const jobsData = [
			{
				id: "Job1",
				type: "task" as const,
				status: "running" as const,
				label: "Job1 running",
				durationMs: 1200,
			},
			{
				id: "Job2",
				type: "task" as const,
				status: "completed" as const,
				label: "Job2 completed",
				durationMs: 3400,
				resultText: "Job2 result",
			},
			{
				id: "Job3",
				type: "task" as const,
				status: "running" as const,
				label: "Job3 running",
				durationMs: 500,
			},
		];

		it("shows all jobs when isPartial is true", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: true } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).toContain("Job3 running");
			expect(output).toContain("waiting on 2 of 3 jobs");
		});

		it("shows only finished jobs when isPartial is false and it is a poll call", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: jobsData },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).not.toContain("Job1 running");
			expect(output).toContain("Job2 completed");
			expect(output).not.toContain("Job3 running");
			expect(output).toContain("1 job settled");
		});

		it("shows nothing when isPartial is false and all jobs are running and it is a poll call", () => {
			const runningJobsOnly = [
				{
					id: "Job1",
					type: "task" as const,
					status: "running" as const,
					label: "Job1 running",
					durationMs: 1200,
				},
			];
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: { op: "wait" as const, jobs: runningJobsOnly },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const lines = component.render(120) as readonly string[];
			expect(lines).toHaveLength(0);
		});

		it("renders agent rows for running agents outside job control", () => {
			const result = {
				content: [{ type: "text" as const, text: "" }],
				details: {
					op: "wait" as const,
					jobs: [],
					agents: [{ id: "Worker", parentId: "Main", activity: "grepping the tree", ageMs: 65_000, live: true }],
				},
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("1 running agent — no jobs");
			expect(output).toContain("Worker");
			expect(output).toContain("grepping the tree");
		});

		it("keeps a sealed bare-poll result visible when it carries an agent roster", () => {
			const result = {
				content: [{ type: "text" as const, text: "No running background jobs to wait for." }],
				details: { op: "wait" as const, jobs: [], agents: [{ id: "Worker", ageMs: 1_000, live: false }] },
			};
			const component = waitToolRenderer.renderResult(
				result,
				{ expanded: true, isPartial: false } as Parameters<typeof waitToolRenderer.renderResult>[1],
				theme,
			);
			const output = Bun.stripANSI((component.render(120) as readonly string[]).join("\n"));
			expect(output).toContain("Worker");
			// A ref claiming `running` with no turn in flight is flagged, not shown
			// as live work.
			expect(output).toContain("no turn");
		});
	});
});
