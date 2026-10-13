import type { ImageBudget } from "../components/image";
import { getKittyGraphics } from "../kitty-graphics";
import {
	calculateImageFit,
	encodeKittyDeleteImage,
	getCellDimensions,
	ImageProtocol,
	isInsideTmux,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import { visibleWidth } from "../utils";
import { RavensHeader, type RavensHeaderTransport, resolveRavensHeaderTransport } from "./ravens-header";
import { RAVENS_LOGO_DIMENSIONS, RAVENS_LOGO_PNG_BASE64 } from "./ravens-logo-data";

const EMPTY_ROWS: readonly string[] = [];

/** Tiny pane-relative graphic; unsupported terminals get no replacement text. */
export class RavensLogo {
	readonly #budget: ImageBudget;
	readonly #header: RavensHeader | undefined;
	#imageId: number;
	#columns = -1;
	#rows = -1;
	#cellWidth = -1;
	#cellHeight = -1;
	#tmux = false;
	// Geometry of the last row that reached a frame under the current id.
	#paintedColumns = -1;
	#paintedRows = -1;
	#lines: readonly string[] = EMPTY_ROWS;

	/** Reserve ids from the owning TUI's allocator without observing an image-budget slot. */
	constructor(
		budget: ImageBudget,
		options: {
			header?: RavensHeaderTransport | null;
			onChange?: () => void;
			emit?: (bytes: string) => void;
		} = {},
	) {
		this.#budget = budget;
		this.#imageId = budget.acquireId();
		const transport = options.header === undefined ? resolveRavensHeaderTransport() : options.header;
		if (transport) {
			this.#header = new RavensHeader(
				transport,
				this.#imageId,
				options.onChange ?? (() => {}),
				options.emit ?? (() => {}),
			);
		}
	}

	/** The logo row for a `columns`×`rows` viewport; empty below two rows. */
	render(columns: number, rows: number): readonly string[] {
		if (this.#header && this.#header.mode !== "inline") {
			const supported = TERMINAL.imageProtocol === ImageProtocol.Kitty && getKittyGraphics().unicodePlaceholders;
			this.#header.sync(
				supported
					? calculateImageFit(RAVENS_LOGO_DIMENSIONS, { maxWidthCells: 4, maxHeightCells: 1 }, getCellDimensions())
							.columns
					: undefined,
			);
			return EMPTY_ROWS;
		}
		// A terminal resize reflows the painted row or pushes it into native
		// history before the app hears about it, and no escape sequence can edit
		// history. Retire the id instead: deleting it blanks every stranded copy,
		// while the row repainted under a fresh id stays visible.
		if (this.#paintedColumns >= 0 && (columns !== this.#paintedColumns || rows !== this.#paintedRows)) {
			this.#budget.purgeFromScreen(this.#imageId);
			this.#imageId = this.#budget.acquireId();
			this.#paintedColumns = -1;
			this.#columns = -1;
		}
		if (
			columns < 1 ||
			rows < 2 ||
			TERMINAL.imageProtocol !== ImageProtocol.Kitty ||
			!getKittyGraphics().unicodePlaceholders
		) {
			this.#columns = -1;
			this.#lines = EMPTY_ROWS;
			return this.#lines;
		}
		const cells = getCellDimensions();
		const tmux = isInsideTmux();
		if (
			columns === this.#columns &&
			rows === this.#rows &&
			cells.widthPx === this.#cellWidth &&
			cells.heightPx === this.#cellHeight &&
			tmux === this.#tmux
		) {
			return this.#lines;
		}
		this.#columns = columns;
		this.#rows = rows;
		this.#cellWidth = cells.widthPx;
		this.#cellHeight = cells.heightPx;
		this.#tmux = tmux;
		const image = renderImage(RAVENS_LOGO_PNG_BASE64, RAVENS_LOGO_DIMENSIONS, {
			maxWidthCells: Math.min(4, columns),
			maxHeightCells: 1,
			imageId: this.#imageId,
			includeTransmit: true,
		});
		const line = image?.lines?.[0];
		if (!line || image?.lines?.length !== 1 || !image.transmit) {
			this.#lines = EMPTY_ROWS;
			return this.#lines;
		}
		// Keep the row self-contained: a replay or a fresh alternate screen may
		// have no image data, even when the cached geometry has not changed.
		// Never trim/slice these bytes: both the APCs and placeholder cells matter.
		this.#lines = [image.transmit + " ".repeat(Math.max(0, columns - visibleWidth(line))) + line];
		this.#paintedColumns = columns;
		this.#paintedRows = rows;
		return this.#lines;
	}

	/** Called on the restored normal screen at shutdown; never deletes chat images. */
	release(): string {
		const headerRelease = this.#header?.release() ?? "";
		this.#columns = -1;
		this.#lines = EMPTY_ROWS;
		if (this.#paintedColumns < 0) return headerRelease;
		this.#paintedColumns = -1;
		return headerRelease + encodeKittyDeleteImage(this.#imageId);
	}
}
