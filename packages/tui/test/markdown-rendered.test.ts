import { afterEach, describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "../src/components/markdown";
import { setTerminalTextSizing } from "../src/terminal-capabilities";
import { loadTheme } from "../src/theme/loader";
import { getMarkdownTheme, setThemeInstance } from "../src/theme/theme";
import { defaultMarkdownTheme } from "./test-themes";

const rows = (markdown: Markdown, width = 60) => markdown.render(width).map(line => Bun.stripANSI(line).trimEnd());

afterEach(() => {
	setTerminalTextSizing(false);
	clearRenderCache();
});

describe("Rendered Markdown instead of source markers", () => {
	it("styles every heading level without source hashes or text sizing", () => {
		for (let depth = 1; depth <= 6; depth++) {
			const markdown = new Markdown(`${"#".repeat(depth)} Heading`, 0, 0, defaultMarkdownTheme);
			expect(rows(markdown)).toEqual(["Heading"]);
			const raw = markdown.render(60).join("");
			expect(raw).toContain("\x1b[1m");
			expect(raw.includes("\x1b[3m")).toBe(depth === 1);
			expect(raw.includes("\x1b[4m")).toBe(depth === 1);
			expect(raw).not.toContain("\x1b]66;");
		}
	});

	it("never flashes heading or fence markers when streaming every character", () => {
		const source =
			"# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n\n```text\ncode\n```\n\n~~~text\nother\n~~~";
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
		markdown.transientRenderCache = true;
		for (let end = 1; end <= source.length; end++) {
			markdown.setText(source.slice(0, end));
			expect(rows(markdown).join("\n")).not.toMatch(/[#`~]/);
		}
		markdown.transientRenderCache = false;
		markdown.setText(source);
		expect(rows(markdown).filter(Boolean)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "  code", "  other"]);
	});

	for (const preset of ["unicode", "nerd", "ascii"] as const) {
		it(`renders ${preset} list and task symbols with matching continuation indents`, async () => {
			setThemeInstance(await loadTheme("dark", { symbolPresetOverride: preset }));
			const theme = getMarkdownTheme();
			const markdown = new Markdown(
				"- first\n  - second\n    - third\n- [ ] Alpha beta gamma delta\n- [x] done\n\n1. ordered",
				0,
				0,
				theme,
			);
			const rendered = rows(markdown, 18);
			const ascii = preset === "ascii";
			expect(rendered).toContain(`${ascii ? "-" : "•"} first`);
			expect(rendered).toContain(`  ${ascii ? "-" : "◦"} second`);
			expect(rendered).toContain(`    ${ascii ? "-" : "▪"} third`);
			expect(rendered).toContain(`${ascii ? "- [ ]" : "• ☐"} Alpha beta`);
			expect(rendered).toContain(`${ascii ? "      " : "    "}gamma delta`);
			expect(rendered).toContain(`${ascii ? "- [x]" : "• ☑"} done`);
			expect(rendered).toContain("1. ordered");
		});
	}

	it("keeps setext, escapes, quote bars, links and autolinks rendered", () => {
		const source =
			"Title\n===\n\nSection\n---\n\n> quote\n\n\\*literal\\* **bold** _em_ `code` ~~gone~~\n\n[link](https://example.com) <https://example.org>";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		expect(rows(markdown).filter(Boolean)).toEqual([
			"Title",
			"Section",
			"│ quote",
			"*literal* bold em code gone",
			"link (https://example.com) https://example.org",
		]);
	});

	for (const [source, expected, style] of [
		["**bold**", "bold", "\x1b[1m"],
		["*italic*", "italic", "\x1b[3m"],
		["_italic_", "italic", "\x1b[3m"],
		["`inline code`", "inline code", "\x1b[33m"],
		["~~strike~~", "strike", "\x1b[9m"],
	] as const) {
		it(`styles ${source} without delimiters after streaming completes`, () => {
			const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
			markdown.transientRenderCache = true;
			for (let end = 1; end <= source.length; end++) {
				markdown.setText(source.slice(0, end));
				markdown.render(60);
			}
			expect(rows(markdown)).toEqual([expected]);
			markdown.transientRenderCache = false;
			expect(rows(markdown)).toEqual([expected]);
			expect(markdown.render(60).join("")).toContain(style);
			expect(markdown.render(60).join("")).not.toContain("\x1b]66;");
		});
	}

	it("preserves literal code markers across growing prefixes and finalization", () => {
		const source = "~~~\n```\n###\n~~~";
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme);
		markdown.transientRenderCache = true;
		for (let end = 1; end <= source.length; end++) {
			markdown.setText(source.slice(0, end));
			markdown.render(60);
		}
		expect(rows(markdown)).toEqual(["  ```", "  ###"]);
		markdown.transientRenderCache = false;
		expect(rows(markdown)).toEqual(["  ```", "  ###"]);
	});

	it("preserves literal marker-only code lines once the fence closes", () => {
		const markdown = new Markdown("```text\ncode\n``\n```", 0, 0, defaultMarkdownTheme);
		markdown.transientRenderCache = true;
		expect(rows(markdown)).toEqual(["  code", "  ``"]);
	});

	it("restores literal incomplete fence candidates when a stream finishes", () => {
		const markdown = new Markdown("`", 0, 0, defaultMarkdownTheme);
		markdown.transientRenderCache = true;
		expect(rows(markdown).join("")).toBe("");
		markdown.transientRenderCache = false;
		expect(rows(markdown)).toEqual(["`"]);
	});
});
