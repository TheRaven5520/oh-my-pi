import { expect, it } from "bun:test";
import { initializeMathJaxRenderer, resolveMathJaxImage } from "../src/theme/mathjax-cache";

it("renders fractions and dynamic calligraphic fonts as bounded PNG images", async () => {
	expect(await initializeMathJaxRenderer()).toBe(true);
	for (const formula of ["\\frac{a}{b}", "\\mathcal{F}(x) = \\mathscr{L}(x)"]) {
		const image = resolveMathJaxImage(formula, "#dddddd", 60);
		expect(image).not.toBeNull();
		if (!image) throw new Error("Expected a rasterized equation");
		const bytes = Buffer.from(image.data, "base64");
		expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(image.widthPx).toBeGreaterThan(0);
		expect(image.widthPx).toBeLessThanOrEqual(4096);
		expect(image.heightPx).toBeGreaterThan(0);
	}
});
