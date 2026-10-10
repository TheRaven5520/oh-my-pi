import { Markdown } from "../components/markdown";
import { TERMINAL } from "../terminal-capabilities";
import { type Component, Container } from "../tui";
import { Text } from "../components/text";
import { getWidthConfigEpoch, sliceByColumn, visibleWidth, wrapTextWithAnsi } from "../utils";

/** The transcript reserves column one for prompt/status markers, then one space. */
const CONTENT_GUTTER = "  ";
const indentedRows = new WeakMap<readonly string[], readonly string[]>();

function indentContent(rows: readonly string[]): readonly string[] {
	const cached = indentedRows.get(rows);
	if (cached) return cached;
	// Image payloads and empty structural rows must remain byte-identical.
	const result = rows.map(row => (row === "" || TERMINAL.isImageLine(row) ? row : CONTENT_GUTTER + row));
	indentedRows.set(rows, result);
	return result;
}

/** Markdown owns relative indentation; the transcript owns its outside gutter. */
export class TranscriptMarkdown extends Markdown {
	override render(width: number): readonly string[] {
		return indentContent(super.render(Math.max(1, width - CONTENT_GUTTER.length)));
	}
}

class ContentColumn extends Container {
	override render(width: number): readonly string[] {
		return indentContent(super.render(Math.max(1, width - CONTENT_GUTTER.length)));
	}
}

/** Wrap an unpadded content component without modifying its text or native description. */
export function transcriptContent(component: Component): Component {
	const column = new ContentColumn();
	column.addChild(component);
	return column;
}

/** Keep a row's two-column marker rail out of its wrapped continuation text. */
export class TranscriptMarkerText extends Text {
	#source?: string;
	#width?: number;
	#widthEpoch?: number;
	#rows: readonly string[] = [];

	override invalidate(): void {
		super.invalidate();
		this.#source = undefined;
	}

	override render(width: number): readonly string[] {
		const source = this.getText();
		const widthEpoch = getWidthConfigEpoch();
		if (source === this.#source && width === this.#width && widthEpoch === this.#widthEpoch) return this.#rows;
		this.#source = source;
		this.#width = width;
		this.#widthEpoch = widthEpoch;
		this.#rows = source.split("\n").flatMap(line => {
			if (!line) return [""];
			const marker = sliceByColumn(line, 0, 2);
			const body = sliceByColumn(line, 2, Math.max(0, visibleWidth(line) - 2));
			return wrapTextWithAnsi(body, Math.max(1, width - 2)).map(
				(row, index) => (index === 0 ? marker : CONTENT_GUTTER) + row,
			);
		});
		return this.#rows;
	}
}
