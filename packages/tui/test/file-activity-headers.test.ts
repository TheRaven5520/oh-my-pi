import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { editToolRenderer } from "@oh-my-pi/pi-tui/tools/edit";
import { type FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { globToolRenderer } from "@oh-my-pi/pi-tui/tools/glob";
import { grepToolRenderer } from "@oh-my-pi/pi-tui/tools/grep";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";

const ui: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};
const done = { expanded: false, isPartial: false };
const text = (value: string) => [{ type: "text", text: value }];
const plain = (card: ToolExecutionComponent) =>
	card
		.render(240)
		.map(line => Bun.stripANSI(line))
		.join("\n");

beforeAll(async () => {
	await initTheme();
});

describe("structured file activity headers", () => {
	it("retains the semantic query while pending and observed counts and failures after completion", () => {
		const card = new ToolExecutionComponent("find", { query: "retry budget" }, {}, undefined, ui, "/tmp");
		expect(plain(card)).toContain('"retry budget" in .');
		const details: FindToolDetails = {
			query: "retry budget",
			keywords: ["retry"],
			threshold: 0.2,
			hits: [],
			cwd: "/tmp",
			scopePath: "src",
			elapsedMs: 10,
			stats: {
				listed: 2,
				requests: 2,
				errors: 1,
				judged: 2,
				filesRead: 2,
				fileBytes: 20,
				inputTokens: 10,
				outputTokens: 0,
				cost: 0,
				apiMs: 5,
				windowsJudged: 1,
				windowsPruned: 0,
				mapCards: 0,
				failures: ["verification: request refused"],
			},
		};
		card.updateResult({ content: text("No relevant passages found"), details }, false);
		const output = plain(card);
		expect(output).toContain('"retry budget" in src');
		expect(output).toContain("0 hits · 2 files read · 1 failed");
		expect(output).toContain("verification: request refused");
	});

	it("keeps search flags in compact and native result headers without counting rendered rows", () => {
		const args = { pattern: "needle", path: "src", case: false, gitignore: false, skip: 2 };
		const result = {
			content: text("one rendered row"),
			details: { scopePath: "src", matchCount: 8, fileCount: 3 },
		};
		const card = new ToolExecutionComponent("grep", args, {}, undefined, ui, "/tmp");
		card.updateResult(result, false);
		const output = plain(card);
		expect(output).toContain("case-insensitive");
		expect(output).toContain("ignored included");
		expect(output).toContain("skip:2");
		expect(output).toContain("8 matches · 3 files");
		const native = grepToolRenderer.describeResult(result, done, args);
		expect(native.tool?.meta).toContain("case-insensitive");
		expect(native.tool?.meta).toContain("ignored included");
	});

	it("shows nondefault glob flags, authoritative counts and default scope", () => {
		const args = { hidden: false, gitignore: false, limit: 4 };
		const result = { content: text("one rendered row"), details: { fileCount: 4, scopePath: "src" } };
		const card = new ToolExecutionComponent("glob", args, {}, undefined, ui, "/tmp");
		card.updateResult(result, false);
		const output = plain(card);
		expect(output).toContain("src");
		expect(output).toContain("hidden excluded");
		expect(output).toContain("ignored included");
		expect(output).toContain("4 files");
		expect(globToolRenderer.describeCall({}).tool?.target).toBe(".");
		expect(globToolRenderer.describeResult(result, done, args).tool?.meta).toContain("hidden excluded");
	});

	it("does not suppress search warning or diagnostic bodies as success receipts", () => {
		const warnings = [
			{ missingPaths: ["missing"] },
			{ meta: { limits: { resultLimit: { reached: 2 } } } },
			{ meta: { diagnostics: { summary: "warning", messages: ["inspect this"] } } },
		];
		for (const warning of warnings) {
			expect(
				grepToolRenderer.activitySummary(
					{ pattern: "x" },
					{
						...done,
						result: { content: text("warning"), details: { matchCount: 2, ...warning } },
					},
				).receipt,
			).toBe(false);
			expect(
				globToolRenderer.activitySummary(
					{},
					{
						...done,
						result: { content: text("warning"), details: { fileCount: 2, ...warning } },
					},
				).receipt,
			).toBe(false);
		}
	});

	it("keeps moved edit identities and per-file diagnostics with cached diff counts", () => {
		const file = {
			path: "new.ts",
			sourcePath: "old.ts",
			diff: "@@ -1 +1 @@\n-old\n+new",
			diagnostics: { summary: "warning", messages: ["new.ts:1:1 unused"] },
		};
		const context = { ...done, result: { content: text("updated"), details: { diff: "", perFileResults: [file] } } };
		const summary = editToolRenderer.activitySummary({ path: "old.ts" }, context);
		expect(summary).toMatchObject({ label: "Move", detail: "old.ts → new.ts", meta: "+1 −1", receipt: false });
		file.diff += "\n+more";
		expect(editToolRenderer.activitySummary({ path: "old.ts" }, context).meta).toBe("+2 −1");
	});

	it("renders metadata-only diagnostics for searches and edits", () => {
		for (const tool of ["grep", "glob", "edit"]) {
			const card = new ToolExecutionComponent(tool, { path: "a.ts", pattern: "needle" }, {}, undefined, ui, "/tmp");
			card.updateResult(
				{
					content: text(""),
					details: {
						matchCount: 0,
						fileCount: 0,
						diff: "",
						path: "a.ts",
						meta: { diagnostics: { summary: "warning", messages: ["a.ts:1:1 metadata warning"] } },
					},
				},
				false,
			);
			card.setExpanded(true);
			expect(plain(card)).toContain("metadata warning");
		}
	});

	it("retains read corrections without source counts and surfaces routed read errors", () => {
		const corrected = readToolRenderer.activitySummary(
			{ path: "typo" },
			{
				...done,
				result: {
					content: text("child.ts"),
					details: { isDirectory: true, suffixResolution: { from: "typo", to: "actual" } },
				},
			},
		);
		expect(corrected).toMatchObject({ detail: "actual", meta: "corrected from typo", receipt: false });
		const routed = readToolRenderer.activitySummary(
			{ path: "proc://" },
			{
				...done,
				result: {
					content: text("Error: unavailable"),
					isError: true,
					details: { proc: { jobs: [], daemons: [] } },
				},
			},
		);
		expect(routed).toMatchObject({
			label: "Proc",
			meta: "0 jobs · 0 services",
			error: "unavailable",
			receipt: false,
		});
	});
});
