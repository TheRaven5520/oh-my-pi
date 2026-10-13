import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentProgress, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { taskToolRenderer } from "@oh-my-pi/pi-tui/tools/task";

describe("task renderer: streaming call preview", () => {
	let theme: Theme;

	beforeAll(async () => {
		const resolved = await getThemeByName("dark");
		expect(resolved).toBeDefined();
		theme = resolved!;
		setThemeInstance(theme);
	});

	function render(args: TaskParams, expanded = false): string {
		const component = taskToolRenderer.renderCall(args, { expanded, isPartial: true }, theme);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("keeps the header compact and the agent identity and assignment on its row", () => {
		const args: TaskParams = {
			agent: "reviewer",
			name: "ReviewAuth",
			task: "Review packages/server/src/auth for missing 401 handling.\nReport findings.",
		};
		const out = render(args);
		const lines = out.split("\n");

		expect(lines[0]).toContain("requested");
		const row = lines.find(line => line.includes("ReviewAuth"));
		expect(row).toBeDefined();
		expect(row).toContain("Review packages/server/src/auth for missing 401 handling.");
		expect(row).not.toContain("Report findings.");
		expect(row).toContain("reviewer");
	});

	it("caps the agent-row brief to a single preview line", () => {
		const args: TaskParams = {
			agent: "task",
			name: "CapCheck",
			task: `${"x".repeat(80)} TAIL_MARKER\nsecond line`,
		};
		const row = render(args)
			.split("\n")
			.find(line => line.includes("CapCheck"));

		expect(row).toBeDefined();
		expect(row).toContain("…");
		expect(row).not.toContain("TAIL_MARKER");
	});

	it("renders partially-streamed args (name only, no task yet) without crashing", () => {
		const args: TaskParams = { name: "First" };

		const out = render(args);

		expect(out).toContain("First");
	});

	it("previews a long task brief when collapsed and renders it in full when expanded", () => {
		const taskLines = Array.from({ length: 6 }, (_, i) => `Step ${i + 1}: do the thing.`);
		const args: TaskParams = {
			agent: "task",
			name: "Worker",
			task: taskLines.join("\n"),
		};

		// Collapsed cards show one assignment summary; expansion keeps every line.
		const collapsed = render(args, false);
		expect(collapsed).toContain("Step 1");
		expect(collapsed).not.toContain("Step 6");
		expect(collapsed).not.toContain("Step 2");

		const expanded = render(args, true);
		expect(expanded).toContain("Step 1");
		expect(expanded).toContain("Step 6");
		expect(expanded).not.toContain("more lines");
	});

	it("surfaces the isolation flag in the header bar", () => {
		const args: TaskParams = {
			agent: "task",
			isolated: true,
			name: "Only",
			task: "...",
		};
		const out = render(args);
		const lines = out.split("\n");

		expect(out).toContain("Only");
		// Isolation is surfaced as header meta in the frame's top bar (first line),
		// not as a trailing child row under the task list.
		expect(lines[0]).toContain("isolated");
	});

	it("renders the roster first and keeps shared context behind expansion", () => {
		const args: TaskParams = {
			context: "# Goal\nFix the bench branches.",
			tasks: [
				{ name: "Fix01Foundation", task: "Fix bench/01-foundation-memory" },
				{ name: "Fix02Setup", task: "Fix bench/02-setup" },
			],
		};
		const out = render(args);

		const contextAt = out.indexOf("Fix the bench branches.");
		const firstAgentAt = out.indexOf("Fix01Foundation");
		expect(contextAt).toBe(-1);
		expect(firstAgentAt).toBeGreaterThanOrEqual(0);
		const expanded = render(args, true);
		expect(expanded.indexOf("Fix the bench branches.")).toBeGreaterThan(expanded.indexOf("Fix01Foundation"));
		expect(out.indexOf("Fix02Setup")).toBeGreaterThan(firstAgentAt);
		// Each item row carries its own first task line as secondary text.
		const row = out.split("\n").find(line => line.includes("Fix01Foundation"));
		expect(row).toContain("Fix bench/01-foundation-memory");
	});

	it("badges non-default agent types on item rows and keeps the generic worker bare", () => {
		const args: TaskParams = {
			context: "ctx",
			tasks: [
				{ name: "Scouty", agent: "scout", task: "map the code" },
				{ name: "Worker", agent: "task", task: "do the work" },
			],
		};
		const out = render(args);

		expect(out.split("\n").find(line => line.includes("Scouty"))).toContain("scout");
		expect(out.split("\n").find(line => line.includes("Worker"))).toContain("task");
		// Agent types live on the item rows; the batch header no longer joins them.
		expect(out.split("\n")[0]).not.toContain("scout");
	});

	// Early in the stream only `context` has parsed; the (empty) agent-list
	// section must not draw a stray trailing divider bar.
	it("omits the agent-list divider while no agent rows exist yet", () => {
		const args: TaskParams = { context: "# Goal\nShared brief." };
		const out = render(args);
		const lines = out.split("\n");

		expect(out).not.toContain("Shared brief.");
		expect(render(args, true)).toContain("Shared brief.");
		// Interior divider bars start with the tee glyph; only the header (top)
		// and bottom border may exist.
		const tee = theme.boxRound.teeRight;
		expect(lines.filter(line => line.trimStart().startsWith(tee))).toHaveLength(0);
	});

	// Once the tool produces a result, the container suppresses the call entirely
	// via `mergeCallAndResult` and `renderResult` draws the agent. As a safety
	// net, `renderCall` also drops its preview when a result snapshot is present,
	// so the two never stack.
	it("drops the preview once a result snapshot exists", () => {
		const args: TaskParams = {
			agent: "reviewer",
			name: "ReviewAuth",
			task: "Review the auth module.",
		};
		const component = taskToolRenderer.renderCall(
			args,
			{ expanded: false, isPartial: true, renderContext: { hasResult: true } },
			theme,
		);
		const out = Bun.stripANSI(component.render(160).join("\n"));

		expect(out).not.toContain("Review the auth module.");
		expect(out).not.toContain("ReviewAuth");
	});

	it("exposes a semantic roster without treating incomplete requests as launches", () => {
		const summary = taskToolRenderer.activitySummary(
			{
				context: "Long shared context",
				tasks: [
					{},
					{ name: "Draft" },
					{
						name: "Ready",
						agent: "scout",
						model: "@smol",
						task: "# Target\nMap the parser.\n# Change\nMore detail",
						solutionSpace: "one path",
					},
				],
			},
			{ expanded: false, isPartial: true },
		);
		expect(summary.detail).toBe("1 agent");
		expect(summary.meta).toBe("requested");
		expect(summary.preview).toHaveLength(2);
		expect(summary.preview?.[0]).toContain("Draft");
		expect(summary.preview?.[1]).toContain("Ready · scout · requested @smol");
		expect(summary.preview?.[1]).toContain("Map the parser.");
		expect(summary.preview?.join("\n")).not.toContain("# Target");
		expect(summary.preview?.join("\n")).not.toContain("Long shared context");
	});

	it("expands every batch assignment and its dispatch details after the roster", () => {
		const args = {
			context: "Shared background",
			tasks: Array.from({ length: 6 }, (_, i) => ({
				name: `Worker${i}`,
				task: `# Target\nAssignment${i}\nFull instructions${i}`,
				solutionSpace: `Choice${i}`,
				model: ["@smol", "@default"],
				tools: ["lookup"],
				outputSchema: { type: "object" },
				schemaMode: "strict" as const,
			})),
		};
		const collapsed = render(args);
		expect(collapsed).toContain("2 more agents");
		expect(collapsed).not.toContain("Full instructions");
		const expanded = render(args, true);
		expect(expanded).toContain("Full instructions5");
		expect(expanded).toContain("Choice5");
		expect(expanded).toContain("lookup");
		expect(expanded).toContain("strict");
		expect(expanded).toContain("object");
		expect(expanded.indexOf("Worker5")).toBeLessThan(expanded.indexOf("Shared background"));
		const native = taskToolRenderer.describeCall(args, { expanded: false, isPartial: true });
		expect(JSON.stringify(native)).not.toContain("Shared background");
		expect(JSON.stringify(native)).not.toContain("Full instructions");
		const nativeExpanded = taskToolRenderer.describeCall(args, { expanded: true, isPartial: true });
		expect(JSON.stringify(nativeExpanded)).toContain("Full instructions5");
		expect(JSON.stringify(nativeExpanded)).toContain("Choice5");
	});

	it("uses actual live identities, without hiding meaningful progress or failures", () => {
		const entry: AgentProgress = {
			index: 0,
			id: "ActualWorker",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "Inspect parser",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		const details: TaskToolDetails = { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [entry] };
		const summarize = (text: string, isError = false) =>
			taskToolRenderer.activitySummary(
				{ name: "RequestedName" },
				{
					expanded: false,
					isPartial: true,
					result: { content: [{ type: "text", text }], details, isError },
				},
			);
		const live = summarize("Running agent ActualWorker...");
		expect(live.detail).toBe("1 agent");
		expect(live.meta).toBe("1 running");
		expect(live.preview?.[0]).toContain("ActualWorker · running");
		expect(live.preview?.[0]).not.toContain("RequestedName");
		expect(summarize("Important finding").preview).toBeUndefined();
		expect(summarize("Running agent ActualWorker...", true).preview).toBeUndefined();
		entry.recentOutput = ["Retry failed"];
		expect(summarize("Running agent ActualWorker...").preview).toBeUndefined();
		entry.recentOutput = [];
		entry.extractedToolData = { yield: [{ type: "finding", data: "Keep this" }] };
		expect(summarize("Running agent ActualWorker...").preview).toBeUndefined();
	});
});
