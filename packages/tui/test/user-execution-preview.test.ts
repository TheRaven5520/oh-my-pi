import { beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { formatArtifactErrorNotice, type TruncationMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

const factories = {
	bash: () => new BashExecutionComponent("printf sample", ui),
	eval: () => new EvalExecutionComponent("print('sample')", ui),
};

function previewText(rows: readonly string[]): string[] {
	return rows.map((row, index) => {
		const text = row.trimStart();
		return index === 0 && text.startsWith(theme.tree.last) ? text.slice(theme.tree.last.length).trimStart() : text;
	});
}

for (const [name, create] of Object.entries(factories)) {
	describe(`${name} compact execution receipts`, () => {
		it("puts singular counts inline and previews actual output", () => {
			const component = create();
			component.setComplete(0, false, { output: "only result\n" });
			const rows = component.render(100).map(row => Bun.stripANSI(row));
			expect(rows).toHaveLength(2);
			expect(rows[0]).toContain("done · 1 line");
			expect(rows[0]).not.toContain("1 lines");
			expect(previewText(rows.slice(1))).toEqual(["only result"]);
		});

		it("keeps empty output header-only without a zero-line receipt", () => {
			const component = create();
			component.setComplete(0, false, { output: "\n  \n" });
			const rows = component.render(100).map(row => Bun.stripANSI(row));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain("done");
			expect(rows[0]).not.toContain("0 lines");
		});

		it("bounds the completed preview and preserves click expansion", () => {
			const component = create();
			component.setComplete(0, false, { output: "first\nsecond\nthird\nfourth\nfifth" });
			const rows = component.render(100).map(row => Bun.stripANSI(row));
			expect(rows).toHaveLength(4);
			expect(rows[0]).toContain("5 lines");
			expect(previewText(rows.slice(1))).toEqual(["first", "second", "third"]);
			expect(component.toggleClickExpansion()).toBe(true);
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("fifth");
			component.setExpanded(false);
			expect(component.render(100).map(row => Bun.stripANSI(row))).toEqual(rows);
		});

		it("keeps running status inline and follows the live tail", () => {
			const component = create();
			try {
				const pending = component.render(100).map(row => Bun.stripANSI(row));
				expect(pending).toHaveLength(1);
				expect(pending[0]).toContain("running");
				component.appendOutput("first\nsecond\nthird\nfourth\nfifth");
				const rows = component.render(100).map(row => Bun.stripANSI(row));
				expect(rows[0]).toContain("running · 5 lines");
				expect(previewText(rows.slice(1))).toEqual(["third", "fourth", "fifth"]);
			} finally {
				component.setComplete(0, false);
			}
		});

		it("preserves failure details at the tail with an inline exit status", () => {
			const component = create();
			component.setComplete(2, false, {
				output: "starting\nworking\ntrace frame\nsource line\nValueError: invalid",
			});
			const rows = component.render(100).map(row => Bun.stripANSI(row));
			expect(rows[0]).toContain("exit 2 · 5 lines");
			expect(previewText(rows.slice(1))).toEqual(["trace frame", "source line", "ValueError: invalid"]);
		});

		it("shows output-free failures and cancellation on the header", () => {
			for (const cancelled of [false, true]) {
				const component = create();
				component.setComplete(2, cancelled, { output: "" });
				const rows = component.render(100).map(row => Bun.stripANSI(row));
				expect(rows).toHaveLength(1);
				expect(rows[0]).toContain(cancelled ? "cancelled" : "exit 2");
			}
		});

		it("preserves capture warnings and artifact access below the preview", () => {
			const truncation: TruncationMeta = {
				direction: "tail",
				truncatedBy: "lines",
				totalLines: 10,
				totalBytes: 100,
				outputLines: 1,
				outputBytes: 10,
				artifactId: "123",
			};
			const component = create();
			component.setComplete(0, false, { output: "last line", truncation, artifactError: "write" });
			const rendered = Bun.stripANSI(component.render(240).join("\n"));
			expect(rendered).toContain("last line");
			expect(rendered).toContain("artifact://123");
			expect(rendered).toContain(formatArtifactErrorNotice("write"));
		});

		it("clamps narrow output without losing the inline status", () => {
			const component = create();
			component.setComplete(0, false, { output: "日本語".repeat(40) });
			for (const width of [1, 8, 24, 50]) {
				const rows = component.render(width);
				expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
				if (width >= 24) expect(Bun.stripANSI(rows[0]!)).toContain("done · 1 line");
			}
		});
	});
}

it("keeps multiline eval source expandable even without output", () => {
	const component = new EvalExecutionComponent("x = 1\ny = 2", ui);
	component.setComplete(0, false, { output: "" });
	expect(component.render(100)).toHaveLength(1);
	expect(component.toggleClickExpansion()).toBe(true);
	expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("y = 2");
});

it("keeps multiline shell commands expandable even without output", () => {
	const component = new BashExecutionComponent("true\nprintf second", ui);
	component.setComplete(0, false, { output: "" });
	expect(component.render(100)).toHaveLength(1);
	expect(component.toggleClickExpansion()).toBe(true);
	expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("printf second");
});

it("keeps clipped output-free source expandable", () => {
	const source = "very_long_source_name_without_output";
	for (const component of [new BashExecutionComponent(source, ui), new EvalExecutionComponent(source, ui)]) {
		component.setComplete(0, false, { output: "" });
		expect(component.render(24)).toHaveLength(1);
		expect(component.toggleClickExpansion()).toBe(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain(source);
	}
});
