import { describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "../src/native/node";
import { askToolRenderer } from "../src/tools/ask";
import { describeDefaultToolExecution } from "../src/tools/default-renderer";
import { describeMCPCall, describeMCPResult } from "../src/tools/mcp";
import type { RenderResultOptions } from "../src/tools/renderer";
import { webSearchToolRenderer } from "../src/tools/web-search";

const opts = { expanded: false, isPartial: false } as RenderResultOptions;

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	return (children ?? []).filter((c): c is NativeNode => typeof c === "object" && c !== null && "k" in c);
}

describe("web_search native view", () => {
	it("heads with the query and lists sources as linked rows with a domain mark", () => {
		const view = webSearchToolRenderer.describeResult(
			{
				content: [],
				details: {
					response: {
						provider: "parallel",
						answer: "The answer",
						sources: [{ url: "https://www.example.com/a", title: "Example", ageSeconds: 3 * 86400 }],
						model: "m1",
						usage: { inputTokens: 5 },
					},
				} as never,
			},
			opts,
			{ query: "what is x" },
		);
		expect(view?.tool?.target).toBe("what is x");
		expect(view?.tool?.targetKind).toBe("query");
		expect(view?.tool?.meta?.[0]).toMatch(/1 source$/);
		expect(view?.tool?.badges?.[0]?.title).toContain("in 5");
		const [answer, sources] = nodes(view?.body);
		expect(answer?.k).toBe("md");
		const rowNode = nodes(sources?.c)[0]!;
		expect(rowNode.p).toMatchObject({ role: "omp.tool.source", href: "https://www.example.com/a" });
		const [mark, title, meta] = nodes(rowNode.c);
		expect(mark?.p).toMatchObject({ text: "E" });
		expect(title?.p).toMatchObject({ spans: [{ href: "https://www.example.com/a" }] });
		expect(meta?.p).toMatchObject({ spans: [{ t: "example.com · 3d" }] });
	});
});

describe("ask native view", () => {
	it("pending call is an inline head naming the question with a waiting line", () => {
		const view = askToolRenderer.describeCall({ question: "Pick one?\nmore", options: [{ label: "A" }] } as never);
		expect(view?.inline).toBe(true);
		expect(view?.tool?.target).toBe("Pick one?");
		expect(nodes(view?.body)).toHaveLength(1);
	});

	it("answered result marks the chosen option and quotes custom input", () => {
		const view = askToolRenderer.describeResult(
			{
				content: [],
				details: { question: "Pick?", options: ["A", "B"], selectedOptions: ["B"], customInput: "own" } as never,
			},
			opts,
		);
		const roles = nodes(view?.body)
			.filter(n => n.k === "row")
			.map(n => n.p?.role);
		expect(roles).toEqual(["omp.tool.answer.off", "omp.tool.answer", "omp.tool.answer"]);
		const custom = nodes(view?.body).at(-1)!;
		expect(JSON.stringify(custom)).toContain("\u201cown\u201d");
	});
});

describe("generic / MCP native views", () => {
	it("keeps generic output and arguments accessible without dumping payloads in the header", () => {
		const view = describeDefaultToolExecution({
			label: "custom",
			args: { path: "src/item.ts", payload: "body-only" },
			result: { output: '{"x":1}', isError: false },
		} as never);
		expect(view.tool).toMatchObject({ title: "custom", targetKind: "text" });
		expect(nodes(view.body)[0]?.k).toBe("tree");
		expect(String(view.tool?.target)).not.toContain("body-only");
		expect(JSON.stringify(view.body)).toContain("body-only");
	});

	it("keeps MCP arguments expandable while its header shows the structured target", () => {
		const args = { query: "hi", payload: "body-only" };
		const call = describeMCPCall(args, "srv/tool");
		expect(call.tool?.target).toContain("hi");
		expect(call.tool?.target).not.toContain("body-only");
		expect(JSON.stringify(call.body)).toContain("body-only");
		const res = describeMCPResult({ content: [{ type: "text", text: "[1,2]" }] }, opts, args);
		expect(nodes(res?.body)[0]?.k).toBe("tree");
		expect(JSON.stringify(res?.body)).toContain("body-only");
	});
});
