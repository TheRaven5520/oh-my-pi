import { getImageDimensions, TERMINAL } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const testImagePath = Bun.argv[2] || "/tmp/test-image.png";

console.log("Terminal capabilities:", TERMINAL);
console.log("Loading image from:", testImagePath);

let imageBuffer: Uint8Array;
try {
	const file = Bun.file(testImagePath);
	imageBuffer = await file.bytes();
} catch {
	console.error(`Failed to load image: ${testImagePath}`);
	console.error("Usage: bun test/image-test.ts [path-to-image.png]");
	process.exit(1);
}

const base64Data = imageBuffer.toBase64();
const dims = getImageDimensions(base64Data, "image/png");

console.log("Image dimensions:", dims);
console.log("");

await initTheme();
const composer = new Composer({
	watermark: false,
	preferences: {
		quiet: true,
		composerShape: "pi",
		spellingAutocomplete: "off",
		spellingTypoDetection: false,
		spellingAutocorrect: false,
	},
});
const transcript = new TranscriptContainer();
transcript.addChild(
	new Text(
		"Image smoke: wheel to browse; Ctrl+R repaints cached rows; Ctrl+L resets the display; Ctrl+Q exits.\n" +
			"Type a draft, clip either edge of an image, select/copy, and resize: images must stay attached to their labels.",
		0,
		0,
	),
);
for (let index = 1; index <= 3; index++) {
	transcript.addChild(new Text(`Image ${index} — top`, 0, 0));
	transcript.addChild(
		new Image(
			base64Data,
			"image/png",
			{ fallbackColor: text => text },
			{ budget: composer.ui.imageBudget, imageKey: `smoke:${index}`, maxWidthCells: 60, maxHeightCells: 14 },
			dims ?? undefined,
		),
	);
	transcript.addChild(
		new Text(
			`Image ${index} — bottom\n` +
				Array.from({ length: 8 }, (_, row) => `Following image ${index}: row ${row + 1}`).join("\n"),
			0,
			0,
		),
	);
}
composer.setRuntimeChildren([transcript, composer.editor], { transient: [composer.editor] });
composer.ui.addInputListener(data => {
	if (matchesKey(data, "ctrl+r")) composer.ui.requestRender(true);
	else if (matchesKey(data, "ctrl+l")) composer.ui.resetDisplay();
	else if (matchesKey(data, "ctrl+q")) {
		composer.stop();
		process.exit(0);
	} else return;
	return { consume: true };
});
composer.start({ playWelcomeIntro: false });
