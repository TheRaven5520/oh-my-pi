import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { checkForNewVersion } from "@oh-my-pi/pi-coding-agent/main";

/** Answer every registry request with a release far newer than any real version. */
function mockRegistryWithNewerRelease() {
	const fetchMock: typeof globalThis.fetch = Object.assign(async () => Response.json({ version: "999.0.0" }), {
		preconnect: globalThis.fetch.preconnect,
	});
	return vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

// Contract: this fork is a self-built binary, so startup must not contact the
// npm registry (nor surface the "run `omp update`" banner that depends on it)
// unless the user opts in. A regression shows up as an unexpected network
// request and an "Update Available" banner on every launch.
describe("startup update check", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("makes no registry request and reports nothing until the user opts in", async () => {
		const registry = mockRegistryWithNewerRelease();

		expect(await checkForNewVersion("0.0.1")).toBeUndefined();
		expect(registry).not.toHaveBeenCalled();
	});

	it("reports a newer release once startup.checkUpdate is turned on", async () => {
		settings.set("startup.checkUpdate", true);
		mockRegistryWithNewerRelease();

		expect(await checkForNewVersion("0.0.1")).toBe("999.0.0");
	});
});
