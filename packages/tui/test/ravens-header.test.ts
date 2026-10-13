import { afterEach, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RavensHeader, type RavensHeaderTransport, TmuxRavensHeaderTransport } from "../src/chrome/ravens-header";
import { encodeKittyPlaceholderCells, encodeKittyVirtualPlacement } from "../src/kitty-graphics";
import { calculateImageFit, encodeKittyTransmit, getPngDimensions } from "../src/terminal-capabilities";
import {
	RAVENS_LOGO_COMPACT_DIMENSIONS,
	RAVENS_LOGO_DIMENSIONS,
	RAVENS_LOGO_PNG_BASE64,
	ravensLogoPngForBox,
} from "../src/chrome/ravens-logo-data";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeTransport implements RavensHeaderTransport {
	readonly replayDir = mkdtempSync(join(tmpdir(), "omp-ravens-test-"));
	state: { enabled: boolean; inMode: boolean } | undefined = { enabled: true, inMode: false };
	owned: { header: string; file: string } | undefined;
	probes = 0;
	publishes = 0;
	failPublish = false;
	readonly clearObservedExisting: boolean[] = [];
	constructor() {
		directories.push(this.replayDir);
	}
	async probe() {
		this.probes++;
		return this.state;
	}
	publish(header: string, file: string): boolean {
		this.publishes++;
		if (this.failPublish) return false;
		this.owned = { header, file };
		return true;
	}
	clear(file: string): void {
		this.clearObservedExisting.push(existsSync(file));
		if (this.owned?.file === file) this.owned = undefined;
	}
}

it("publishes exact raw replay bytes and color-addressed cells with private permissions", async () => {
	const transport = new FakeTransport();
	const emitted: string[] = [];
	const header = new RavensHeader(
		transport,
		0xa0a1b2,
		() => {},
		bytes => emitted.push(bytes),
	);
	expect(header.mode).toBe("pending");
	await Promise.resolve();
	header.sync(4);
	await Promise.resolve();
	const owned = transport.owned!;
	expect(owned.header).toBe(`#[fg=#a0a1b2,us=#a0a1b2]${encodeKittyPlaceholderCells(0, 4)}`);
	expect(owned.header).not.toContain("\x1b");
	const raw = readFileSync(owned.file, "utf8");
	expect(raw).toBe(
		encodeKittyTransmit(RAVENS_LOGO_PNG_BASE64, 0xa0a1b2, false) +
			encodeKittyVirtualPlacement({
				imageId: 0xa0a1b2,
				placementId: 0xa0a1b2,
				columns: 4,
				rows: 1,
				passthrough: false,
			}),
	);
	expect(raw).not.toContain("\x1bPtmux;");
	expect(statSync(owned.file).mode & 0o777).toBe(0o600);
	expect(statSync(transport.replayDir).mode & 0o777).toBe(0o700);
	expect(emitted).toHaveLength(1);
	expect(emitted[0]).toContain("\x1bPtmux;");
	for (let i = 0; i < 100; i++) header.sync(4);
	expect(transport.probes).toBe(2);
	expect(transport.publishes).toBe(1);
	expect(header.release()).toContain("a=d,d=I,i=10527154");
	expect(transport.owned).toBeUndefined();
	expect(transport.clearObservedExisting).toEqual([true]);
	expect(existsSync(owned.file)).toBe(false);
	expect(header.release()).toBe("");
});

it("selects the native compact raster only for a matching pixel box", () => {
	expect(getPngDimensions(ravensLogoPngForBox(56, 29))).toEqual(RAVENS_LOGO_COMPACT_DIMENSIONS);
	expect(getPngDimensions(RAVENS_LOGO_PNG_BASE64)).toEqual(RAVENS_LOGO_DIMENSIONS);
	expect(
		calculateImageFit(
			RAVENS_LOGO_COMPACT_DIMENSIONS,
			{ maxWidthCells: 4, maxHeightCells: 1 },
			{ widthPx: 14, heightPx: 29 },
		),
	).toEqual({ columns: 4, rows: 1 });
	expect(ravensLogoPngForBox(56, 27)).toBe(ravensLogoPngForBox(56, 29));
	for (const [width, height] of [
		[40, 20],
		[56, 26],
		[64, 32],
		[112, 58],
	]) {
		expect(ravensLogoPngForBox(width!, height!)).toBe(RAVENS_LOGO_PNG_BASE64);
	}
});

it("replaces replay pixels without changing cells or ids when cell geometry changes", async () => {
	const transport = new FakeTransport();
	transport.state = { enabled: true, inMode: true };
	const emitted: string[] = [];
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		bytes => emitted.push(bytes),
	);
	await Promise.resolve();
	header.sync(4);
	await Promise.resolve();
	const first = transport.owned!;
	const compact = ravensLogoPngForBox(56, 29);
	header.sync(4, compact);
	await Promise.resolve();
	expect(transport.owned!.header).toBe(first.header);
	expect(existsSync(first.file)).toBe(false);
	expect(readFileSync(transport.owned!.file, "utf8")).toContain(encodeKittyTransmit(compact, 100, false));
	expect(readFileSync(transport.owned!.file, "utf8")).toContain("a=p,U=1,q=2,i=100,p=100,c=4,r=1");
	for (let i = 0; i < 100; i++) header.sync(4, compact);
	expect(transport.publishes).toBe(2);
	expect(emitted).toEqual([]);
	header.sync(4);
	await Promise.resolve();
	expect(readFileSync(transport.owned!.file, "utf8")).toContain(
		encodeKittyTransmit(RAVENS_LOGO_PNG_BASE64, 100, false),
	);
	header.release();
});

it("publishes during copy mode for direct replay without dropped pane passthrough", async () => {
	const transport = new FakeTransport();
	transport.state = { enabled: true, inMode: true };
	const emitted: string[] = [];
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		bytes => emitted.push(bytes),
	);
	await Promise.resolve();
	header.sync(4);
	await Promise.resolve();
	expect(transport.owned).toBeDefined();
	expect(emitted).toEqual([]);
	header.release();
});

it.each([undefined, { enabled: false, inMode: false }])(
	"falls back when initial opt-in is unavailable: %j",
	async state => {
		const transport = new FakeTransport();
		transport.state = state;
		const header = new RavensHeader(
			transport,
			100,
			() => {},
			() => {},
		);
		await Promise.resolve();
		expect(header.mode).toBe("inline");
		header.sync(4);
		expect(transport.publishes).toBe(0);
		header.release();
	},
);

it("preserves foreign pane options when releasing its own replay file", async () => {
	const transport = new FakeTransport();
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		() => {},
	);
	await Promise.resolve();
	header.sync(4);
	await Promise.resolve();
	const file = transport.owned!.file;
	transport.owned = { header: "foreign", file: "/other-owner.apc" };
	header.release();
	expect(transport.owned).toEqual({ header: "foreign", file: "/other-owner.apc" });
	expect(existsSync(file)).toBe(false);
});

it("clears a published header on capability loss and replaces geometry without leaking files", async () => {
	const transport = new FakeTransport();
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		() => {},
	);
	await Promise.resolve();
	header.sync(4);
	await Promise.resolve();
	const first = transport.owned!.file;
	header.sync(3);
	await Promise.resolve();
	expect(existsSync(first)).toBe(false);
	expect(transport.owned!.header).toContain("#[fg=#000064,us=#000064]");
	const second = transport.owned!.file;
	header.sync(undefined);
	await Promise.resolve();
	expect(transport.owned).toBeUndefined();
	expect(existsSync(second)).toBe(false);
	header.release();
});

it("stops after three failed publications without a retry timer", async () => {
	const transport = new FakeTransport();
	transport.failPublish = true;
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		() => {},
	);
	await Promise.resolve();
	for (let i = 0; i < 10; i++) {
		header.sync(4);
		await Promise.resolve();
	}
	expect(header.mode).toBe("inline");
	expect(transport.probes).toBe(4);
	expect(transport.publishes).toBe(3);
	header.release();
});

it.each(["permissions", "symlink", "collision"])("rejects unsafe replay storage: %s", async kind => {
	const transport = new FakeTransport();
	const marker = join(transport.replayDir, `${process.pid}-100-1.apc`);
	if (kind === "permissions") chmodSync(transport.replayDir, 0o777);
	if (kind === "symlink") {
		const target = mkdtempSync(join(tmpdir(), "omp-ravens-target-"));
		directories.push(target);
		rmSync(transport.replayDir, { recursive: true });
		symlinkSync(target, transport.replayDir);
	}
	if (kind === "collision") writeFileSync(marker, "foreign", { mode: 0o600 });
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		() => {},
	);
	await Promise.resolve();
	header.sync(4);
	await Promise.resolve();
	expect(transport.publishes).toBe(0);
	if (kind === "collision") expect(readFileSync(marker, "utf8")).toBe("foreign");
	header.release();
});

it("does not publish after release while an async probe is outstanding", async () => {
	const transport = new FakeTransport();
	const header = new RavensHeader(
		transport,
		100,
		() => {},
		() => {},
	);
	await Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<{ enabled: boolean; inMode: boolean }>();
	transport.probe = () => promise;
	header.sync(4);
	header.release();
	resolve({ enabled: true, inMode: false });
	await Promise.resolve();
	expect(transport.publishes).toBe(0);
});

const tmux = Bun.which("tmux");
it.skipIf(!tmux)("uses real tmux pane options and compare-and-clear without touching another server", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-ravens-tmux-"));
	directories.push(dir);
	const socket = join(dir, "socket");
	const env = { ...process.env, TMUX: `${socket},0,0` };
	const run = (...args: string[]) =>
		Bun.spawnSync([tmux!, "-S", socket, ...args], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 2000,
			killSignal: "SIGKILL",
		});
	try {
		const start = run("-f", "/dev/null", "new-session", "-d", "-s", "header", "sleep 60");
		expect(start.exitCode).toBe(0);
		const pane = run("display-message", "-p", "#{pane_id}").stdout.toString().trim();
		expect(run("set-option", "-g", "@omp-ravens-header-enabled", "1").exitCode).toBe(0);
		expect(run("set-option", "-g", "pane-border-status", "top").exitCode).toBe(0);
		const transport = new TmuxRavensHeaderTransport(tmux!, pane, env, dir);
		expect(await transport.probe()).toEqual({ enabled: true, inMode: false });
		expect(run("copy-mode", "-t", pane).exitCode).toBe(0);
		expect(await transport.probe()).toEqual({ enabled: true, inMode: true });
		const file = join(dir, "owned.apc");
		const value = `#[fg=#000064,us=#000064]${encodeKittyPlaceholderCells(0, 4)}`;
		expect(transport.publish(value, file)).toBe(true);
		expect(run("show-options", "-pqv", "-t", pane, "@omp-ravens-header").stdout.toString().trim()).toBe(value);
		transport.clear(join(dir, "foreign.apc"));
		expect(run("show-options", "-pqv", "-t", pane, "@omp-ravens-header").stdout.toString().trim()).toBe(value);
		transport.clear(file);
		expect(run("show-options", "-pqv", "-t", pane, "@omp-ravens-header").stdout.toString().trim()).toBe("");
	} finally {
		run("kill-server");
	}
});
