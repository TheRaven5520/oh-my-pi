import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { getBinaryName } from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupCheckUpdate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { checkForNewVersion } from "@oh-my-pi/pi-coding-agent/main";

const content = "published Spring executable";
const tag = "v999.0.0-spring.2";

function mockSprilicred() {
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			// Only the test key file may be read; a real ~/.sprilicred/user.key must never be used.
			if (new Headers(init?.headers).get("authorization") !== "Bearer sk-spr-test") {
				return new Response("", { status: 401 });
			}
			if (url.endsWith("/omp/latest/VERSION")) return new Response(`${tag}\n`);
			if (url.endsWith("/omp/latest/SHA256SUMS.txt")) {
				return new Response(`${Bun.SHA256.hash(content, "hex")}  ${getBinaryName()}\n`);
			}
			return new Response("not found", { status: 404 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	return vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

describe("startup update check", () => {
	let directory: string;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		directory = await mkdtemp(join(os.tmpdir(), "spring-update-check-"));
		vi.spyOn(os, "homedir").mockReturnValue(directory);
		await mkdir(join(directory, ".sprilicred"));
		await writeFile(join(directory, ".sprilicred", "user.key"), "sk-spr-test\n");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await rm(directory, { recursive: true, force: true });
	});

	// Official release binaries only; a self-built omp is covered by its own case below.
	const release = true;

	it("makes no Sprilicred request until the user opts in", async () => {
		const requests = mockSprilicred();
		expect(await checkForNewVersion("0.0.1", process.execPath, release)).toBeUndefined();
		expect(requests).not.toHaveBeenCalled();
	});

	it("reports the complete fork tag for a newer base version", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		mockSprilicred();
		expect(await checkForNewVersion("0.0.1", process.execPath, release)).toBe("999.0.0-spring.2");
	});

	it("never offers the Spring build to a self-built omp", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		const requests = mockSprilicred();
		expect(await checkForNewVersion("0.0.1", process.execPath, false)).toBeUndefined();
		expect(await checkForNewVersion("0.0.1")).toBeUndefined();
		expect(requests).not.toHaveBeenCalled();
	});

	it("distinguishes Spring revisions sharing one native version by the executable digest", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		mockSprilicred();
		const binary = join(directory, "omp");
		await Bun.write(binary, "previous Spring executable");
		expect(await checkForNewVersion("999.0.0", binary, release)).toBe("999.0.0-spring.2");
		await Bun.write(binary, content);
		expect(await checkForNewVersion("999.0.0", binary, release)).toBeUndefined();
	});

	it("never treats a missing binary as a matching release or recommends a base-version downgrade", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		mockSprilicred();
		expect(await checkForNewVersion("999.0.0", join(directory, "missing"), release)).toBe("999.0.0-spring.2");
		expect(await checkForNewVersion("999.0.1", join(directory, "missing"), release)).toBeUndefined();
	});

	it("stays silent without a Sprilicred key", async () => {
		cfgStartupCheckUpdate.set(settings, true);
		const requests = mockSprilicred();
		await rm(join(directory, ".sprilicred"), { recursive: true });
		expect(await checkForNewVersion("0.0.1", process.execPath, release)).toBeUndefined();
		expect(requests).not.toHaveBeenCalled();
	});
});
