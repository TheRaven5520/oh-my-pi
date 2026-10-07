import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBinaryName } from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupCheckUpdate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { checkForNewVersion } from "@oh-my-pi/pi-coding-agent/main";

const content = "published Spring executable";
const tag = "v999.0.0-spring.2";
function mockForkRelease() {
	const name = getBinaryName();
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				tag_name: tag,
				draft: false,
				prerelease: false,
				assets: [
					{
						name,
						state: "uploaded",
						size: Buffer.byteLength(content),
						digest: `sha256:${Bun.SHA256.hash(content, "hex")}`,
						browser_download_url: `https://github.com/Spring-Silicon/oh-my-pi/releases/download/${tag}/${name}`,
						url: "https://api.github.com/repos/Spring-Silicon/oh-my-pi/releases/assets/1",
					},
				],
			}),
		{ preconnect: globalThis.fetch.preconnect },
	);
	return vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("startup update check", () => {
	let directory: string;
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		directory = await mkdtemp(join(tmpdir(), "spring-update-check-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await rm(directory, { recursive: true, force: true });
	});
	it("makes no release request until the user opts in", async () => {
		const releases = mockForkRelease();
		expect(await checkForNewVersion("0.0.1")).toBeUndefined();
		expect(releases).not.toHaveBeenCalled();
	});
	it("reports the complete fork tag for a newer base version", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		mockForkRelease();
		expect(await checkForNewVersion("0.0.1")).toBe("999.0.0-spring.2");
	});
	it("distinguishes Spring revisions sharing one native version by the executable digest", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		mockForkRelease();
		const binary = join(directory, "omp");
		await Bun.write(binary, "previous Spring executable");
		expect(await checkForNewVersion("999.0.0", binary)).toBe("999.0.0-spring.2");
		await Bun.write(binary, content);
		expect(await checkForNewVersion("999.0.0", binary)).toBeUndefined();
	});
	it("never treats a missing binary as a matching release or recommends a base-version downgrade", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		mockForkRelease();
		expect(await checkForNewVersion("999.0.0", join(directory, "missing"))).toBe("999.0.0-spring.2");
		expect(await checkForNewVersion("999.0.1", join(directory, "missing"))).toBeUndefined();
	});
});
