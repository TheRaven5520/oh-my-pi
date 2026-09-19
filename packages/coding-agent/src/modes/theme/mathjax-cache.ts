import { mathjax } from "@mathjax/src/js/mathjax.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/cases/CasesConfiguration.js";
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
// Side effect: registers an import()-based `mathjax.asyncLoad` so dynamic font
// ranges (calligraphic, script, ...) are loadable outside a browser.
import "@mathjax/src/js/util/asyncLoad/esm.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };
import { getCellDimensions } from "@oh-my-pi/pi-tui";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";

export interface MathJaxImage {
	data: string;
	mimeType: "image/png";
	widthPx: number;
	heightPx: number;
	key: string;
}

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const tex = new TeX({
	packages: ["base", "ams", "boldsymbol", "cancel", "cases", "color", "newcommand"],
});
const svgOutput = new SVG({ fontCache: "none" });
const document = mathjax.document("", { InputJax: tex, OutputJax: svgOutput });
const imageCache = new LRUCache<string, MathJaxImage>({ max: 256 });
let ready = false;
let initialization: Promise<boolean> | undefined;

/**
 * Initialize the portable resvg WASM backend and eagerly load every dynamic
 * MathJax font range once. The render path converts synchronously, so dynamic
 * ranges (calligraphic, script, ...) must be resident before first use;
 * without a registered `mathjax.asyncLoad`, on-demand loading throws
 * "No mathjax.asyncLoad method specified" mid-render. Failures leave Unicode
 * math as the fallback (wasm failure) or per-formula fallback (font failure).
 */
export function initializeMathJaxRenderer(): Promise<boolean> {
	if (ready) return Promise.resolve(true);
	if (initialization) return initialization;
	initialization = (async () => {
		await initWasm(await Bun.file(resvgWasmPath).arrayBuffer());
		// Prefetch all dynamic font ranges so the synchronous convert path never
		// triggers on-demand loading mid-render; on failure those glyph ranges
		// fall back per-formula while base typesetting keeps working.
		await svgOutput.font.loadDynamicFiles().catch(() => {});
		ready = true;
		return true;
	})().catch(() => false);
	return initialization;
}

export function clearMathJaxCache(): void {
	imageCache.clear();
}

/** Typeset display LaTeX and rasterize it to a transparent, terminal-ready PNG. */
export function resolveMathJaxImage(source: string, foreground: string, maxWidthCells: number): MathJaxImage | null {
	if (!ready) return null;
	const normalized = source.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return null;
	const cells = Math.max(1, Math.floor(maxWidthCells));
	const key = `${foreground}\x00${cells}\x00${normalized}`;
	const cached = imageCache.get(key);
	if (cached) return cached;

	try {
		const node = document.convert(normalized, { display: true });
		const container = adaptor.outerHTML(node);
		if (container.includes('data-mml-node="merror"')) return null;
		const start = container.indexOf("<svg");
		const end = container.lastIndexOf("</svg>");
		if (start < 0 || end < start) return null;
		const svg = container.slice(start, end + 6).replaceAll("currentColor", foreground);
		const zoom = 2;
		let rasterizer = new Resvg(svg, { fitTo: { mode: "zoom", value: zoom } });
		let rendered = rasterizer.render();
		const cellDimensions = getCellDimensions();
		const maxWidthPx = Math.max(64, Math.min(4096, cells * cellDimensions.widthPx * zoom));
		if (rendered.width > maxWidthPx) {
			rasterizer.free();
			rasterizer = new Resvg(svg, { fitTo: { mode: "width", value: maxWidthPx } });
			rendered = rasterizer.render();
		}
		const png = rendered.asPng();
		const image: MathJaxImage = {
			data: Buffer.from(png).toString("base64"),
			mimeType: "image/png",
			widthPx: rendered.width,
			heightPx: rendered.height,
			key: Bun.hash(key).toString(16),
		};
		rasterizer.free();
		imageCache.set(key, image);
		return image;
	} catch {
		return null;
	}
}
