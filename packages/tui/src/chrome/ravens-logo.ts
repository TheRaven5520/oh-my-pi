import { getKittyGraphics } from "../kitty-graphics";
import {
	encodeKittyDeleteImage,
	getCellDimensions,
	ImageProtocol,
	isInsideTmux,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import { visibleWidth } from "../utils";
import { RAVENS_LOGO_DIMENSIONS, RAVENS_LOGO_PNG_BASE64 } from "./ravens-logo-data";

const EMPTY_ROWS: readonly string[] = [];

/** Tiny pane-relative graphic; unsupported terminals get no replacement text. */
export class RavensLogo {
	readonly #imageId: number;
	#width = -1;
	#cellWidth = -1;
	#cellHeight = -1;
	#tmux = false;
	#rendered = false;
	#rows: readonly string[] = EMPTY_ROWS;

	/** Reserve from the owning TUI's allocator without observing an image-budget slot. */
	constructor(imageId: number) {
		this.#imageId = imageId;
	}

	render(width: number, maxRows: number): readonly string[] {
		if (
			width < 1 ||
			maxRows < 1 ||
			TERMINAL.imageProtocol !== ImageProtocol.Kitty ||
			!getKittyGraphics().unicodePlaceholders
		) {
			this.#width = -1;
			this.#rows = EMPTY_ROWS;
			return this.#rows;
		}
		const cells = getCellDimensions();
		const tmux = isInsideTmux();
		if (
			width === this.#width &&
			cells.widthPx === this.#cellWidth &&
			cells.heightPx === this.#cellHeight &&
			tmux === this.#tmux
		) {
			return this.#rows;
		}
		this.#width = width;
		this.#cellWidth = cells.widthPx;
		this.#cellHeight = cells.heightPx;
		this.#tmux = tmux;
		const image = renderImage(RAVENS_LOGO_PNG_BASE64, RAVENS_LOGO_DIMENSIONS, {
			maxWidthCells: Math.min(4, width),
			maxHeightCells: 1,
			imageId: this.#imageId,
			includeTransmit: true,
		});
		const line = image?.lines?.[0];
		if (!line || image?.lines?.length !== 1 || !image.transmit) {
			this.#rows = EMPTY_ROWS;
			return this.#rows;
		}
		// Keep the row self-contained: a replay or a fresh alternate screen may
		// have no image data, even when the cached geometry has not changed.
		// Never trim/slice these bytes: both the APCs and placeholder cells matter.
		this.#rows = [image.transmit + " ".repeat(Math.max(0, width - visibleWidth(line))) + line];
		this.#rendered = true;
		return this.#rows;
	}

	/** Called on the restored normal screen at shutdown; never deletes chat images. */
	release(): string {
		this.#width = -1;
		this.#rows = EMPTY_ROWS;
		if (!this.#rendered) return "";
		this.#rendered = false;
		return encodeKittyDeleteImage(this.#imageId);
	}
}
