import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildInstallerCommand,
	buildInstallerEnv,
	getBinaryName,
	getLatestRelease,
	isUpdateAvailable,
	parseChecksum,
	parseReleaseTag,
} from "../../src/cli/update-cli";

const digest = (content: string) => Bun.SHA256.hash(content, "hex");

describe("Spring Silicon binary names", () => {
	it("names the three published platforms", () => {
		expect(getBinaryName("darwin", "arm64")).toBe("omp-darwin-arm64");
		expect(getBinaryName("linux", "x64")).toBe("omp-linux-x64");
		expect(getBinaryName("linux", "arm64")).toBe("omp-linux-arm64");
	});

	it("rejects platforms Sprilicred does not publish", () => {
		expect(() => getBinaryName("darwin", "x64")).toThrow("darwin-arm64, linux-x64 and linux-arm64");
		expect(() => getBinaryName("win32", "x64")).toThrow("win32-x64");
	});
});

describe("Sprilicred release metadata", () => {
	it("accepts only Spring release tags", () => {
		expect(parseReleaseTag("v18.6.1-spring.5")).toBe("18.6.1");
		expect(() => parseReleaseTag("v18.6.1")).toThrow("unsupported");
		expect(() => parseReleaseTag("18.6.1-spring.5")).toThrow("unsupported");
	});

	it("reads exactly one sha256sum entry for the binary", () => {
		const sums = `${"a".repeat(64)}  omp-linux-x64\n${"B".repeat(64)} *omp-linux-arm64\n`;
		expect(parseChecksum(sums, "omp-linux-x64")).toBe("a".repeat(64));
		expect(parseChecksum(sums, "omp-linux-arm64")).toBe("b".repeat(64));
		expect(() => parseChecksum(sums, "omp-darwin-arm64")).toThrow("0 entries");
		expect(() => parseChecksum(`${sums}${sums}`, "omp-linux-x64")).toThrow("2 entries");
	});
});

describe("getLatestRelease", () => {
	let dir: string;
	let keyPath: string;
	let requests: { url: string; authorization: string | null }[];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-cli-"));
		keyPath = path.join(dir, "user.key");
		await fs.writeFile(keyPath, "sk-spr-test\n");
		requests = [];
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function serve(files: Record<string, Response | (() => Response)>) {
		return async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
			const file = files[url.slice(url.lastIndexOf("/") + 1)];
			if (!file) return new Response("not found", { status: 404 });
			return typeof file === "function" ? file() : file;
		};
	}

	it("reads VERSION and the platform checksum with the key file as Bearer", async () => {
		const release = await getLatestRelease({
			keyPath,
			baseUrl: "https://spr.test",
			binaryName: "omp-linux-arm64",
			fetchImpl: serve({
				VERSION: new Response("v18.6.1-spring.5\n"),
				"SHA256SUMS.txt": new Response(`${"c".repeat(64)}  omp-linux-arm64\n`),
			}),
		});
		expect(release).toEqual({ tag: "v18.6.1-spring.5", version: "18.6.1", sha256: "c".repeat(64) });
		expect(requests.map(request => request.url).sort()).toEqual([
			"https://spr.test/omp/latest/SHA256SUMS.txt",
			"https://spr.test/omp/latest/VERSION",
		]);
		expect(requests.every(request => request.authorization === "Bearer sk-spr-test")).toBe(true);
	});

	it("still reports the version when the checksums are unavailable", async () => {
		const release = await getLatestRelease({
			keyPath,
			baseUrl: "https://spr.test",
			binaryName: "omp-linux-x64",
			fetchImpl: serve({ VERSION: new Response("v18.6.1-spring.5") }),
		});
		expect(release).toEqual({ tag: "v18.6.1-spring.5", version: "18.6.1", sha256: undefined });
	});

	it("explains a rejected key, a missing key file, and an unpublished build", async () => {
		const rejected = serve({ VERSION: () => new Response("", { status: 401 }) });
		await expect(getLatestRelease({ keyPath, baseUrl: "https://spr.test", fetchImpl: rejected })).rejects.toThrow(
			`Sprilicred rejected the key in ${keyPath}`,
		);
		await expect(
			getLatestRelease({ keyPath: path.join(dir, "missing.key"), baseUrl: "https://spr.test", fetchImpl: rejected }),
		).rejects.toThrow("No Sprilicred key at");
		const unpublished = serve({ VERSION: () => new Response("nothing published yet\n", { status: 404 }) });
		await expect(getLatestRelease({ keyPath, baseUrl: "https://spr.test", fetchImpl: unpublished })).rejects.toThrow(
			"Sprilicred has no published omp VERSION: nothing published yet",
		);
	});
});

describe("isUpdateAvailable", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-digest-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("compares versions first, then the binary digest of the same version", async () => {
		const binary = path.join(dir, "omp");
		await Bun.write(binary, "published");
		const release = { tag: "v2.0.0-spring.3", version: "2.0.0", sha256: digest("published") };
		expect(await isUpdateAvailable(release, binary, "1.9.9")).toBe(true);
		expect(await isUpdateAvailable(release, binary, "2.0.1")).toBe(false);
		expect(await isUpdateAvailable(release, binary, "2.0.0")).toBe(false);
		await Bun.write(binary, "older spring revision");
		expect(await isUpdateAvailable(release, binary, "2.0.0")).toBe(true);
		expect(await isUpdateAvailable(release, path.join(dir, "missing"), "2.0.0")).toBe(true);
		expect(await isUpdateAvailable({ ...release, sha256: undefined }, binary, "2.0.0")).toBe(false);
	});
});

describe("omp update installer delegation", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-installer-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function runWithCurl(curl: string) {
		await Bun.write(path.join(dir, "curl"), curl);
		await fs.chmod(path.join(dir, "curl"), 0o755);
		const proc = Bun.spawn(buildInstallerCommand("https://spr.test"), {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return { stdout, exitCode };
	}

	it("pipes the installer from the Sprilicred URL into sh with --clients omp --yes", async () => {
		const command = buildInstallerCommand("https://spr.test");
		expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(command[2]).toContain('curl -fsSL "$1/install.sh"');
		expect(command[2]).toContain("sh -s -- --clients omp --yes");
		expect(command.at(-1)).toBe("https://spr.test");

		const result = await runWithCurl(`#!/bin/sh\necho "echo url=$2"\necho 'echo args="$*"'\necho 'exit 7'\n`);
		expect(result.stdout).toBe("url=https://spr.test/install.sh\nargs=--clients omp --yes\n");
		expect(result.exitCode).toBe(7);
	});

	it("fails when the installer download fails instead of running an empty script", async () => {
		const result = await runWithCurl("#!/bin/sh\nexit 22\n");
		expect(result.exitCode).toBe(22);
	});

	it("keeps the launcher marker out of the installer's environment", () => {
		const env = buildInstallerEnv({
			OMP_LAUNCHER_OWNS_CLI: "1",
			SPRILICRED_URL: "https://spr.test",
			EMPTY: undefined,
		});
		expect(env).toEqual({ SPRILICRED_URL: "https://spr.test" });
	});
});
