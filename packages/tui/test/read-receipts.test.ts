import { beforeAll, describe, expect, it } from "bun:test";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { readResultLineCount, readToolRenderer, type ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const ui: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

function result(text: string, details?: ReadToolDetails) {
	return { content: [{ type: "text", text }], details };
}

function plain(component: { render(width: number): readonly string[] }, width = 120): string[] {
	return component.render(width).map(line => Bun.stripANSI(line));
}

beforeAll(async () => {
	await initTheme();
});

describe("read source line counts", () => {
	it("counts source text instead of model headers or terminal wrapping", () => {
		expect(
			readResultLineCount(
				result("header\n1:source\nfooter", {
					displayContent: { text: "a".repeat(300), startLine: 8 },
				}),
			),
		).toBe(1);
		expect(readResultLineCount(result("one\ntwo\n"))).toBe(2);
		expect(readResultLineCount(result(""))).toBe(0);
	});

	it("uses summary metadata when source text is unavailable and ignores elision rows", () => {
		expect(
			readResultLineCount(
				result("summary notice", {
					summary: { lines: 40, elidedSpans: 2, elidedLines: 90 },
				}),
			),
		).toBe(40);
		expect(
			readResultLineCount(
				result("model text", {
					displayContent: { text: "first\n…\nlast", startLine: 1, lineNumbers: [1, null, 50] },
				}),
			),
		).toBe(2);
	});

	it("does not count errors, directories or image captions as source lines", () => {
		expect(readResultLineCount({ ...result("Error: missing"), isError: true })).toBeUndefined();
		expect(readResultLineCount(result("file.txt", { isDirectory: true }))).toBeUndefined();
		expect(readResultLineCount({ content: [{ type: "text", text: "caption" }, { type: "image" }] })).toBeUndefined();
	});
});

describe("read group receipts", () => {
	it("expands a content-bearing read on click even when previews are disabled", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "src/a.ts" }, "read");
		group.updateResult(
			result("header\nsource line 1\nsource line 2", {
				displayContent: { text: "source line 1\nsource line 2", startLine: 1 },
			}),
			false,
			"read",
		);

		expect(group.getClickToolId()).toBeDefined();
		expect(plain(group).join("\n")).not.toContain("source line 2");
		expect(group.toggleClickExpansion()).toBe(true);
		expect(plain(group).join("\n")).toContain("source line 2");
	});

	it("renders one source-count header and restores it after individual expansion", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "src/a.ts:10-49" }, "read");
		const source = Array.from({ length: 40 }, (_, index) => `source line ${index}`).join("\n");
		group.updateResult(
			result("model header\nformatted content\nfooter", {
				displayContent: { text: source, startLine: 10 },
			}),
			false,
			"read",
		);
		const collapsed = plain(group);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("Read src/a.ts:10-49 · 40 lines");
		expect(group.toggleClickExpansion()).toBe(true);
		expect(plain(group).join("\n")).toContain("source line 39");
		expect(group.toggleClickExpansion()).toBe(true);
		expect(plain(group)).toEqual(collapsed);
		expect(group.render(30).every(line => visibleWidth(line) <= 30)).toBe(true);
	});

	it("keeps grouped paths, selectors, per-file counts and error messages visible", () => {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "src/a.ts:1-2,8" }, "a");
		group.updateResult(result("first\nsecond\nlast"), false, "a");
		group.updateArgs({ path: "src/b.ts:20-21" }, "b");
		group.updateResult(result("one\ntwo"), false, "b");
		group.updateArgs({ path: "src/missing.ts" }, "missing");
		group.updateResult({ ...result("Error: ENOENT missing file"), isError: true }, false, "missing");
		const output = plain(group).join("\n");
		expect(output).toContain("Read (3)");
		expect(output).toContain("src/a.ts:1-2,8 · 3 lines");
		expect(output).toContain("src/b.ts:20-21 · 2 lines");
		expect(output).toContain("src/missing.ts");
		expect(output).toContain("ENOENT missing file");
	});

	it("never attributes an aggregate multi-file count to each recovered target", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "a.ts b.ts" }, "read");
		group.updateResult(result("combined\noutput", { displayReadTargets: ["a.ts:1", "b.ts:2"] }), false, "read");
		const output = plain(group).join("\n");
		expect(output).toContain("a.ts:1");
		expect(output).toContain("b.ts:2");
		expect(output).not.toContain("2 lines");
	});

	it("retains correction, conflict and warning details beside the receipt", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "typo.ts:2" }, "read");
		group.updateResult(
			result("source", {
				suffixResolution: { from: "typo.ts", to: "actual.ts" },
				conflictCount: 2,
				notes: ["Source warning"],
			}),
			false,
			"read",
		);
		const output = plain(group).join("\n");
		expect(output).toContain("actual.ts:2");
		expect(output).toContain("corrected from typo.ts");
		expect(output).toContain("2 conflicts");
		expect(output).toContain("1 line");
		expect(output).toContain("Source warning");
	});
});

describe("generic read receipts", () => {
	it("uses one header for success and retains full expansion and errors", () => {
		const card = new ToolExecutionComponent("read", { path: "a.ts" }, {}, undefined, ui, "/tmp");
		card.updateResult(result("one\ntwo\nthree\nfour"), false);
		const collapsed = plain(card);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("4 lines");
		card.setExpanded(true);
		expect(plain(card).join("\n")).toContain("four");
		card.setExpanded(false);
		expect(plain(card)).toEqual(collapsed);
		card.updateResult({ ...result("Error: permission denied"), isError: true }, false);
		expect(plain(card).join("\n")).toContain("permission denied");
		card.seal();
	});

	it("does not hide pending, partial, URL, routed, image or warning output", () => {
		const context = { expanded: false, isPartial: false };
		expect(readToolRenderer.activitySummary({ path: "a.ts" }, context).receipt).not.toBe(true);
		expect(
			readToolRenderer.activitySummary(
				{ path: "a.ts" },
				{
					...context,
					isPartial: true,
					result: result("source"),
				},
			).receipt,
		).not.toBe(true);
		for (const path of ["https://example.com", "proc://", "cfg://"]) {
			expect(readToolRenderer.activitySummary({ path }, { ...context, result: result("source") }).receipt).not.toBe(
				true,
			);
		}
		expect(
			readToolRenderer.activitySummary(
				{ path: "image.png" },
				{
					...context,
					result: { content: [{ type: "image" }, { type: "text", text: "caption" }] },
				},
			).receipt,
		).not.toBe(true);
		expect(
			readToolRenderer.activitySummary(
				{ path: "a.ts" },
				{
					...context,
					result: result("source", { notes: ["warning"] }),
				},
			).receipt,
		).toBe(false);
	});
});
