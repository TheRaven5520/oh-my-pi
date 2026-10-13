import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { XdevMountedRenderer, XdevMountedState } from "@oh-my-pi/pi-tui/tools/xdev";

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
	it.each([
		["lsp", { action: "references", file: "src/main.ts", line: 12 }, ["References", "src/main.ts:12"]],
		["debug", { action: "set_breakpoints", file: "app.py" }, ["Debug set breakpoints", "app.py"]],
		["ast_grep", { pat: "foo($A)", path: "src" }, ["AST Grep", "foo($A)", "src"]],
		["ast_edit", { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["src"] }, ["AST Edit", "foo($A)", "src"]],
		[
			"github",
			{ op: "search_issues", query: "is:open label:bug", repo: "owner/repo" },
			["GitHub Search Issues", "is:open label:bug", "owner/repo"],
		],
		["web_search", { query: "compiler release notes" }, ["Web search", "compiler release notes"]],
		["recall", { query: "build preferences" }, ["Recall memory", "build preferences"]],
		["reflect", { query: "release process" }, ["Reflect on memory", "release process"]],
	] as const)("keeps %s operation and target on direct and xd calls", (name, args, expected) => {
		for (const component of [
			card(name, args),
			card("write", { path: `xd://${name}`, content: JSON.stringify(args) }),
		]) {
			const output = rendered(component);
			for (const value of expected) expect(output).toContain(value);
			component.seal();
		}
	});

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

	it("preserves custom call ownership and forwards inner result metadata to activities", () => {
		const renderer: XdevMountedRenderer = {
			label: "Custom Probe",
			activitySummary(args, context) {
				const input = args as { name?: string };
				const details = context.result?.details as { count?: number } | undefined;
				return {
					label: "Inspect probe",
					detail: input.name,
					meta: details ? `${details.count} probes` : undefined,
				};
			},
			renderCall: () => new Text("Custom body", 0, 0),
		};
		const xdev: XdevMountedState = { mountedNames: new Set(), tools: new Map(), resolve: () => renderer };
		const tool = { name: "write", label: "Write", session: { xdev } } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://probe", content: '{"name":"requested"}' },
			{ useBuiltInRenderer: true },
			tool,
			ui,
		);
		component.setExecutionStarted();
		expect(rendered(component)).toContain("Custom body");
		component.updateResult(
			{
				content: [{ type: "text", text: "Probe body" }],
				details: { xdev: { tool: "probe", mode: "execute", args: { name: "resolved" }, inner: { count: 3 } } },
			},
			false,
		);
		expect(rendered(component)).toContain("resolved");
		expect(rendered(component)).toContain("3 probes");
		component.seal();
	});
});
