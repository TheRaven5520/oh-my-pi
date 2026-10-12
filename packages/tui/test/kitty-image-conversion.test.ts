import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

const IMAGE: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/jpeg",
};
const originalProtocol = TERMINAL.imageProtocol;

describe("Tool image rendering", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		vi.spyOn(Bun.Image.prototype, "png").mockImplementation(() => {
			throw new TypeError("synchronous image conversion failure");
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
	});

	it("omits restored tool-result images when conversion throws synchronously", () => {
		let imageUpdates = 0;
		const component = new AssistantMessageComponent(undefined, false, () => imageUpdates++);

		component.setToolResultImages("restored-read", [IMAGE]);
		expect(imageUpdates).toBe(0);
	});

	it("omits live tool-result images when conversion throws synchronously", () => {
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent("read", { path: "repro.jpg" }, {}, undefined, {
			requestRender,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});

		component.updateResult({ content: [IMAGE] }, false);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("surfaces images returned through xdev write results", () => {
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://generate_image" },
			{ showImages: true },
			undefined,
			{
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				resetDisplay: vi.fn(),
			},
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "Generated 1 image" }],
				details: {
					xdev: {
						tool: "generate_image",
						mode: "execute",
						inner: {
							images: [{ data: IMAGE.data, mimeType: "image/png" }],
						},
					},
				},
			},
			false,
		);

		component.setExpanded(true);
		expect(component.render(80).join("\n")).toContain("\x1b_G");
	});
});

describe("Kitty PNG conversion cache", () => {
	// Each test owns payload sizes nothing else converts: the conversion cache is
	// process-wide by design, so shared fixtures would arrive pre-warmed.
	const SEED_PNG = Buffer.from(IMAGE.data, "base64");
	const images: ImageContent[] = [];
	let rebuildImage: ImageContent;
	let liveImage: ImageContent;
	let evictedImage: ImageContent;
	const floodImages: ImageContent[] = [];
	let delayedToolImage: ImageContent;
	let delayedAssistantImage: ImageContent;
	let rejectedImage: ImageContent;
	let lateProtocolImage: ImageContent;
	let hiddenToolImage: ImageContent;
	let conversionGate: Promise<void> | undefined;
	let encodes = 0;
	let originalPng: typeof Bun.Image.prototype.png;
	/** When set, conversions publish this base64 payload instead of the real PNG. */
	let oversizedPng: string | undefined;

	function finishedMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/** Resolves once `count` conversions have published their result. */
	function converted(count: number): { promise: Promise<void>; notify: () => void } {
		const { promise, resolve } = Promise.withResolvers<void>();
		let seen = 0;
		return {
			promise,
			notify: () => {
				if (++seen >= count) resolve();
			},
		};
	}

	async function webpImage(edge: number): Promise<ImageContent> {
		const webp = await new Bun.Image(SEED_PNG).resize(edge, edge).webp().bytes();
		return { type: "image", data: Buffer.from(webp).toString("base64"), mimeType: "image/webp" };
	}

	beforeAll(async () => {
		await initTheme();
		for (const edge of [137, 139, 141]) images.push(await webpImage(edge));
		rebuildImage = await webpImage(143);
		liveImage = await webpImage(145);
		evictedImage = await webpImage(147);
		for (const edge of [149, 151]) floodImages.push(await webpImage(edge));
		delayedToolImage = await webpImage(153);
		delayedAssistantImage = await webpImage(155);
		rejectedImage = await webpImage(157);
		lateProtocolImage = await webpImage(159);
		hiddenToolImage = await webpImage(161);
	});

	beforeEach(() => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		encodes = 0;
		oversizedPng = undefined;
		conversionGate = undefined;
		originalPng = Bun.Image.prototype.png;
		vi.spyOn(Bun.Image.prototype, "png").mockImplementation(function (this: Bun.Image) {
			encodes++;
			const encoder = originalPng.call(this);
			if (conversionGate) {
				const gate = conversionGate;
				return Object.assign(Object.create(encoder), {
					toBase64: async () => {
						await gate;
						return encoder.toBase64();
					},
				});
			}
			if (oversizedPng === undefined) return encoder;
			const payload = oversizedPng;
			return Object.assign(Object.create(encoder), { toBase64: async () => payload });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalImageProtocol(originalProtocol);
	});

	it("converts each tool-result image once across re-delivery and rebuilt components", async () => {
		const first = converted(images.length);
		const component = new AssistantMessageComponent(undefined, false, first.notify);
		component.setToolResultImages("call-1", images);
		await first.promise;
		expect(encodes).toBe(images.length);

		// Read-result replay delivers the same images again for one toolCallId.
		component.setToolResultImages("call-1", images);
		expect(encodes).toBe(images.length);

		// Transcript rebuilds (resume, rewind, /tree) construct fresh components.
		for (let rebuild = 0; rebuild < 2; rebuild++) {
			new AssistantMessageComponent(undefined, false, () => {}).setToolResultImages("call-1", images);
		}
		expect(encodes).toBe(images.length);
	});

	it("renders an already-converted image on a rebuilt component without waiting for a conversion", async () => {
		const warmed = converted(1);
		const warm = new AssistantMessageComponent(undefined, false, warmed.notify);
		warm.setToolResultImages("call-1", [rebuildImage]);
		await warmed.promise;

		const rebuilt = new AssistantMessageComponent(finishedMessage(), false, () => {});
		rebuilt.setToolResultImages("call-1", [rebuildImage]);

		// Synchronous: no await between delivery and render.
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
	});

	it("keeps a displayed conversion after the shared cache evicts it", async () => {
		const shown = converted(1);
		const component = new AssistantMessageComponent(finishedMessage(), false, shown.notify);
		component.setToolResultImages("call-1", [evictedImage]);
		await shown.promise;

		// Flood the bounded shared cache with conversions past its byte ceiling.
		oversizedPng = "A".repeat(20 * 1024 * 1024);
		const flooded = converted(floodImages.length);
		new AssistantMessageComponent(undefined, false, flooded.notify).setToolResultImages("call-2", floodImages);
		await flooded.promise;

		// A theme change re-renders every component synchronously.
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("\x1b_G");
	});

	it("converts a live tool-result image once across repeated results and rebuilt components", async () => {
		const displayed = converted(1);
		const ui = {
			requestRender: vi.fn(() => displayed.notify()),
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		};
		const component = new ToolExecutionComponent("read", { path: "shot.webp" }, { showImages: true }, undefined, ui);
		component.updateResult({ content: [liveImage] }, false);
		await displayed.promise;
		expect(encodes).toBe(1);

		component.updateResult({ content: [liveImage] }, false);
		const rebuilt = new ToolExecutionComponent("read", { path: "shot.webp" }, { showImages: true }, undefined, ui);
		rebuilt.updateResult({ content: [liveImage] }, false);
		expect(encodes).toBe(1);
		rebuilt.setExpanded(true);
		expect(rebuilt.render(80).join("\n")).toContain("\x1b_G");
	});

	it("retains a completed tool until real PNG conversion can retire with its image", async () => {
		const gate = Promise.withResolvers<void>();
		conversionGate = gate.promise;
		const displayed = converted(1);
		const component = new ToolExecutionComponent("read", { path: "delayed.webp" }, {}, undefined, {
			requestRender: displayed.notify,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});
		component.setExpanded(true);
		component.updateResult({ content: [delayedToolImage] });
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		gate.resolve();
		await displayed.promise;
		const batch = transcript.peekFlushBatch(80);
		expect(batch?.rows.join("\n")).toContain("\x1b_G");
		expect(encodes).toBe(1);
	});

	it("retains a settled assistant through a pending read and real PNG conversion", async () => {
		const gate = Promise.withResolvers<void>();
		conversionGate = gate.promise;
		const displayed = converted(1);
		const component = new AssistantMessageComponent(finishedMessage(), false, displayed.notify);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		expect(transcript.peekFinalizedBatch(80, 100)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["settled"]);
		component.setToolResultImagesPending("read", true);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		component.setToolResultImages("read", [delayedAssistantImage]);
		component.setToolResultImagesPending("read", false);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		gate.resolve();
		await displayed.promise;
		expect(transcript.peekFlushBatch(80)?.rows.join("\n")).toContain("\x1b_G");
		expect(encodes).toBe(1);
	});

	it("releases hidden tool-image holds without releasing visible assistant images", async () => {
		const gate = Promise.withResolvers<void>();
		conversionGate = gate.promise;
		const displayed = converted(3);
		const toolOnly = new AssistantMessageComponent(finishedMessage(), false, displayed.notify);
		toolOnly.setToolResultImages("read", [hiddenToolImage]);
		const hiddenFirst = new AssistantMessageComponent(finishedMessage(), false, displayed.notify);
		hiddenFirst.setToolResultImagesVisible(false);
		hiddenFirst.setToolResultImages("read", [hiddenToolImage]);
		const native = new AssistantMessageComponent(
			{ ...finishedMessage(), content: [hiddenToolImage] },
			false,
			displayed.notify,
		);
		native.setToolResultImagesVisible(false);
		try {
			expect(toolOnly.isTranscriptBlockFinalized()).toBe(false);
			toolOnly.setToolResultImagesVisible(false);
			expect(toolOnly.isTranscriptBlockFinalized()).toBe(true);
			expect(hiddenFirst.isTranscriptBlockFinalized()).toBe(true);
			expect(native.isTranscriptBlockFinalized()).toBe(false);
			toolOnly.setToolResultImagesVisible(true);
			expect(toolOnly.isTranscriptBlockFinalized()).toBe(false);
		} finally {
			gate.resolve();
			await displayed.promise;
		}
		expect(native.isTranscriptBlockFinalized()).toBe(true);
		expect(encodes).toBe(1);
	});

	it("releases image retirement holds when shared conversion rejects", async () => {
		const gate = Promise.withResolvers<void>();
		conversionGate = gate.promise;
		const settled = converted(2);
		const tool = new ToolExecutionComponent("read", { path: "broken.webp" }, {}, undefined, {
			requestRender: settled.notify,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});
		const assistant = new AssistantMessageComponent(finishedMessage(), false, settled.notify);
		tool.updateResult({ content: [rejectedImage] });
		assistant.setToolResultImages("read", [rejectedImage]);
		expect(tool.isTranscriptBlockFinalized()).toBe(false);
		expect(assistant.isTranscriptBlockFinalized()).toBe(false);
		gate.reject(new Error("decode failed"));
		await settled.promise;
		expect(tool.isTranscriptBlockFinalized()).toBe(true);
		expect(assistant.isTranscriptBlockFinalized()).toBe(true);
		expect(encodes).toBe(1);
	});

	it("releases pending reads independently, including reads without images", () => {
		const component = new AssistantMessageComponent(finishedMessage());
		component.setToolResultImagesPending("one", true);
		component.setToolResultImagesPending("two", true);
		component.setToolResultImagesPending("one", false);
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		component.setToolResultImagesPending("two", false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("starts conversion when Kitty detection arrives after the tool result", async () => {
		setTerminalImageProtocol(null);
		const displayed = converted(1);
		const component = new ToolExecutionComponent("read", { path: "early.webp" }, {}, undefined, {
			requestRender: displayed.notify,
			requestComponentRender: vi.fn(),
			resetDisplay: vi.fn(),
		});
		component.updateResult({ content: [lateProtocolImage] });
		expect(encodes).toBe(0);
		setTerminalImageProtocol(ImageProtocol.Kitty);
		component.invalidate();
		await displayed.promise;
		component.setExpanded(true);
		expect(component.render(80).join("\n")).toContain("\x1b_G");
		expect(encodes).toBe(1);
	});
});
