import { describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import {
	TranscriptContainer,
	type TranscriptStableRow,
	type TranscriptWindowAnchor,
} from "@oh-my-pi/pi-tui/chrome/transcript-container";

class Block implements Component {
	renders = 0;

	constructor(
		public rows: readonly string[],
		public finalized = false,
	) {}

	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}

	render(): readonly string[] {
		this.renders++;
		return this.rows;
	}
}

class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	stableReads = 0;
	readonly stable: readonly TranscriptStableRow[] = [{ key: "first" }, { key: "second" }];

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		this.stableReads++;
		return this.stable;
	}

	renderTranscriptStableRows(count: number): readonly string[] {
		return this.rows.slice(0, count);
	}
}

function transcript(...blocks: Component[]): TranscriptContainer {
	const container = new TranscriptContainer();
	for (const block of blocks) container.addChild(block);
	return container;
}

describe("TranscriptContainer.renderWindow", () => {
	it("browses retired and live blocks without changing retirement or duplicating rows", () => {
		const retired = new Block(["old one", "old two"], true);
		const container = transcript(retired);
		const batch = container.peekFlushBatch(80)!;
		container.acknowledgeFinalizedBatch(batch.id);
		const live = new Block(["new one", "new two"]);
		container.addChild(live);
		const states = container.blockStates();
		const emitted = container.emittedStableRows();

		const tail = container.renderWindow(80, 2, undefined);
		expect(tail.rows).toEqual(["new one", "new two"]);
		expect(tail.anchor).toEqual({ component: live, row: 0 });
		expect(tail.atEnd).toBe(true);
		const older = container.renderWindow(80, 2, tail.anchor, -3);
		expect(older.rows).toEqual(["old one", "old two"]);
		expect(older.atEnd).toBe(false);
		expect(container.renderWindow(80, 10, older.anchor).rows).toEqual([
			"old one",
			"old two",
			"",
			"new one",
			"new two",
		]);
		expect(container.blockStates()).toEqual(states);
		expect(container.emittedStableRows()).toEqual(emitted);
		expect(container.peekFlushBatch(80)).toBeUndefined();
	});

	it("keeps an outstanding retirement offer intact", () => {
		const container = transcript(new Block(["settled"], true), new Block(["live"]));
		const batch = container.peekFinalizedBatch(80, 1)!;
		expect(batch).toBeDefined();
		const states = container.blockStates();
		expect(container.renderWindow(80, 20, undefined).rows).toEqual(["settled", "", "live"]);
		expect(container.blockStates()).toEqual(states);
		expect(container.peekFinalizedBatch(80, 1)).toBe(batch);
		container.acknowledgeFinalizedBatch(batch.id);
		expect(container.blockStates()).toEqual(["committed", "active"]);
	});

	it("includes published append-only heads without republishing or sampling stable state", () => {
		const block = new AppendBlock(["first", "second", "partial"]);
		const container = transcript(block);
		const batch = container.peekFinalizedBatch(80, 1)!;
		container.acknowledgeFinalizedBatch(batch.id);
		const reads = block.stableReads;
		expect(container.emittedStableRows()).toEqual([2]);
		const tail = container.renderWindow(80, 1, undefined);
		expect(tail.rows).toEqual(["partial"]);
		expect(container.renderWindow(80, 3, tail.anchor, -2).rows).toEqual(["first", "second", "partial"]);
		expect(block.stableReads).toBe(reads);
		expect(container.emittedStableRows()).toEqual([2]);
		block.rows = ["first", "second", "updated", "latest"];
		expect(container.renderWindow(80, 2, tail.anchor).rows).toEqual(["updated", "latest"]);
		expect(block.stableReads).toBe(reads);
	});

	it("preserves the top when draft reveal shrinks or grows the viewport", () => {
		const block = new Block(["one", "two", "three", "four", "five"]);
		const container = transcript(block);
		const full = container.renderWindow(80, 4, undefined);
		const revealed = container.renderWindow(80, 2, full.anchor);
		expect(revealed.rows).toEqual(["two", "three"]);
		expect(revealed.anchor).toEqual(full.anchor);
		expect(revealed.atEnd).toBe(false);
		const hidden = container.renderWindow(80, 10, revealed.anchor);
		expect(hidden.rows).toEqual(["two", "three", "four", "five"]);
		expect(hidden.anchor).toEqual(full.anchor);
		expect(hidden.atEnd).toBe(true);
	});

	it("keeps the supplied anchor when content is appended", () => {
		const block = new Block(["one", "two", "three"]);
		const container = transcript(block);
		const original = container.renderWindow(80, 2, undefined);
		block.rows = ["one", "two", "three", "four"];
		container.addChild(new Block(["five"]));
		const anchored = container.renderWindow(80, 2, original.anchor);
		expect(anchored.rows).toEqual(original.rows);
		expect(anchored.anchor).toEqual(original.anchor);
		expect(anchored.atEnd).toBe(false);
		expect(container.renderWindow(80, 2, undefined).rows).toEqual(["", "five"]);
	});

	it("matches semantic row scrolling across text, tools, empty blocks and separators", () => {
		const text = new Block(["", "text one", "text two", " "]);
		const first = new ToolBlock(["tool one"]);
		const second = new ToolBlock(["tool two", "tool three"]);
		const last = new Block(["answer"]);
		const container = transcript(new Block([]), text, first, new Block([" "]), second, last, new Block([]));
		const semantic = ["text one", "text two", "", "tool one", "tool two", "tool three", "", "answer"];
		const anchors: TranscriptWindowAnchor[] = [
			{ component: text, row: 0 },
			{ component: text, row: 1 },
			{ component: first, row: -1 },
			{ component: first, row: 0 },
			{ component: second, row: 0 },
			{ component: second, row: 1 },
			{ component: last, row: -1 },
			{ component: last, row: 0 },
		];
		for (let height = 1; height <= 10; height++) {
			const tail = container.renderWindow(80, height, undefined);
			expect(tail.rows).toEqual(semantic.slice(-height));
			expect(tail.atEnd).toBe(true);
			for (let index = 0; index < anchors.length; index++) {
				for (let delta = -10; delta <= 10; delta++) {
					const start =
						delta > 0
							? Math.min(index + delta, Math.max(0, semantic.length - height))
							: Math.max(0, index + delta);
					const window = container.renderWindow(80, height, anchors[index], delta);
					expect(window.rows).toEqual(semantic.slice(start, start + height));
					expect(window.anchor).toEqual(anchors[start]);
					expect(window.atEnd).toBe(start + height >= semantic.length);
					for (let row = 0; row < window.rows.length; row++) {
						const owner = window.spans.find(span => span.start <= row && row < span.end)?.component;
						expect(owner).toBe(semantic[start + row] === "" ? undefined : anchors[start + row]!.component);
					}
					expect(container.getLastViewportSpans()).toBe(window.spans);
				}
			}
		}
	});

	it("falls back to the tail for removed or newly empty anchors", () => {
		const first = new Block(["first"]);
		const last = new Block(["last one", "last two"]);
		const container = transcript(first, last);
		const anchor = { component: first, row: 0 };
		first.rows = [];
		expect(container.renderWindow(80, 1, anchor).rows).toEqual(["last two"]);
		container.removeChild(first);
		expect(container.renderWindow(80, 1, anchor).anchor).toEqual({ component: last, row: 1 });
	});

	it("clamps a reflowed anchor within the same component", () => {
		class ReflowBlock extends Block {
			override render(width = 80): readonly string[] {
				return width < 10 ? ["a", "b", "c", "d"] : ["abcd"];
			}
		}
		const block = new ReflowBlock([]);
		const container = transcript(block, new Block(["later"]));
		const narrow = container.renderWindow(4, 1, { component: block, row: 3 });
		expect(narrow.rows).toEqual(["d"]);
		const wide = container.renderWindow(80, 1, narrow.anchor);
		expect(wide.rows).toEqual(["abcd"]);
		expect(wide.anchor).toEqual({ component: block, row: 0 });
	});

	it("handles empty transcripts and zero-height viewports without rendering blocks", () => {
		const empty = transcript(new Block([" "]));
		expect(empty.renderWindow(80, 1, undefined)).toEqual({ rows: [], spans: [], anchor: undefined, atEnd: true });
		const block = new Block(["one", "two"]);
		const container = transcript(block);
		const anchor = { component: block, row: 0 };
		expect(container.renderWindow(80, 0, anchor)).toEqual({ rows: [], spans: [], anchor, atEnd: false });
		expect(container.renderWindow(80, -1, undefined)).toEqual({
			rows: [],
			spans: [],
			anchor: undefined,
			atEnd: true,
		});
		expect(block.renders).toBe(0);
		expect(container.renderWindow(80, 1, anchor).rows).toEqual(["one"]);
	});

	it("renders only nearby blocks and does not retain stale rows between calls", () => {
		const blocks = Array.from({ length: 500 }, (_, index) => new ToolBlock([`row ${index}`]));
		const container = transcript(...blocks);
		const tail = container.renderWindow(80, 3, undefined);
		expect(tail.rows).toEqual(["row 497", "row 498", "row 499"]);
		expect(blocks.reduce((sum, block) => sum + block.renders, 0)).toBe(3);
		for (const block of blocks) block.renders = 0;
		const middle = container.renderWindow(80, 3, { component: blocks[200]!, row: 0 }, 1);
		expect(middle.rows).toEqual(["row 201", "row 202", "row 203"]);
		expect(blocks.reduce((sum, block) => sum + block.renders, 0)).toBeLessThanOrEqual(5);
		expect(blocks[499]!.renders).toBe(0);
		blocks[201]!.rows = ["changed"];
		expect(container.renderWindow(80, 3, middle.anchor).rows[0]).toBe("changed");
	});
});
