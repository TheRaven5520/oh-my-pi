import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ui: ToolExecutionUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

function rendered(card: ToolExecutionComponent): string {
	return card
		.render(180)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function card(name: string, args: Record<string, unknown>): ToolExecutionComponent {
	const component = new ToolExecutionComponent(name, args, {}, undefined, ui, "/tmp");
	component.setExecutionStarted();
	return component;
}

beforeAll(async () => {
	await initTheme();
});

describe("structured tool activity headers", () => {

	it("uses observed AST counts, preserving preview and partial-scope facts through xd", () => {
		const args = { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src"] };
		const details = {
			totalReplacements: 7,
			filesTouched: 2,
			filesSearched: 10,
			applied: false,
			limitReached: true,
			parseErrors: ["unparsed.ts: invalid syntax"],
		};
		const content = [{ type: "text", text: "Full rewrite detail" }];
		const direct = card("ast_edit", args);
		const mounted = card("write", { path: "xd://ast_edit", content: JSON.stringify(args) });
		direct.updateResult({ content, details }, false);
		mounted.updateResult(
			{ content, details: { xdev: { tool: "ast_edit", mode: "execute", args, inner: details } } },
			false,
		);
		for (const component of [direct, mounted]) {
			const output = rendered(component);
			for (const value of ["7 replacements", "2 files", "preview", "limit reached", "parse"]) {
				expect(output).toContain(value);
			}
			component.setExpanded(true);
			expect(rendered(component)).toContain("Full rewrite detail");
			component.seal();
		}
	});

	it("shows observed sources instead of requested limits", () => {
		const component = card("web_search", { query: "compiler release notes", num_search_results: 20 });
		component.updateResult(
			{
				content: [{ type: "text", text: "Full search answer" }],
				details: {
					response: {
						provider: "none",
						sources: [{ title: "Release", url: "https://example.com/release" }],
						answer: "Full search answer",
					},
				},
			},
			false,
		);
		expect(rendered(component)).toContain("1 source");
		expect(rendered(component)).not.toContain("20 sources");
		component.seal();
	});

	it("keeps memory content out of activity headers", () => {
		const component = card("retain", { items: [{ content: "PRIVATE MEMORY BODY" }] });
		expect(rendered(component)).toContain("1 item");
		expect(rendered(component)).not.toContain("PRIVATE MEMORY BODY");
		component.updateResult({ content: [{ type: "text", text: "Stored" }], details: { count: 1 } }, false);
		expect(rendered(component)).toContain("1 retained");
		component.setExpanded(true);
		expect(rendered(component)).toContain("PRIVATE MEMORY BODY");
		component.seal();
	});

});
