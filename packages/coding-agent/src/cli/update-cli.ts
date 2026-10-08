/**
 * Update CLI command handler.
 *
 * The Spring Silicon omp build is installed and updated by one tool: the
 * Sprilicred installer, which serves the binaries to holders of a valid
 * Sprilicred key. `omp update` runs that installer for omp; `omp update --check`
 * and the opt-in startup check only read the published release from Sprilicred.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, APP_NAME, compareVersions, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";

const DEFAULT_SPRILICRED_URL = "https://sprilicred.taila2d385.ts.net";
const KEY_FILE = path.join(".sprilicred", "user.key");
const RELEASE_METADATA_TIMEOUT_MS = 30_000;

/**
 * `curl -fsSL "$URL/install.sh" | sh -s -- --clients omp --yes`, with the
 * Sprilicred URL passed as `$1`. The script is downloaded before it is piped
 * so a failed download (no pipefail in dash) fails the update instead of
 * feeding an empty script to `sh`, which would exit 0.
 */
const INSTALLER_SCRIPT =
	'script=$(curl -fsSL "$1/install.sh") || exit $?; printf \'%s\\n\' "$script" | sh -s -- --clients omp --yes';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The Spring Silicon omp build Sprilicred currently publishes. */
export interface PublishedRelease {
	/** Release tag, e.g. `v18.6.1-spring.5`. */
	tag: string;
	/** omp version the tag builds (`18.6.1`), comparable with {@link VERSION}. */
	version: string;
	/**
	 * Lower-case hex SHA-256 of this platform's binary, when Sprilicred's
	 * SHA256SUMS.txt could be read and lists it.
	 */
	sha256?: string;
}

/** Sprilicred base URL: `SPRILICRED_URL` or the Spring Silicon deployment. */
export function sprilicredUrl(env: Record<string, string | undefined> = process.env): string {
	return (env.SPRILICRED_URL || DEFAULT_SPRILICRED_URL).replace(/\/+$/, "");
}

/** The single file holding the Sprilicred key, shared by every client. */
export function sprilicredKeyPath(home: string = os.homedir()): string {
	return path.join(home, KEY_FILE);
}

/** Name of the published binary for a platform. */
export function getBinaryName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	if (platform === "darwin" && arch === "arm64") return `${APP_NAME}-darwin-arm64`;
	if (platform === "linux" && arch === "x64") return `${APP_NAME}-linux-x64`;
	if (platform === "linux" && arch === "arm64") return `${APP_NAME}-linux-arm64`;
	throw new Error(
		`No Spring Silicon omp build for ${platform}-${arch}; supported platforms are darwin-arm64, linux-x64 and linux-arm64`,
	);
}

/** Parse a Spring Silicon release tag (`v18.6.1-spring.5`) into its omp version. */
export function parseReleaseTag(tag: string): string {
	const version = /^v(\d+\.\d+\.\d+)-spring\.\d+$/.exec(tag)?.[1];
	if (!version) throw new Error(`Sprilicred published an unsupported omp release tag: ${JSON.stringify(tag)}`);
	return version;
}

/** Find the SHA-256 for `binaryName` in sha256sum-format text; exactly one entry must match. */
export function parseChecksum(sums: string, binaryName: string): string {
	const matches: string[] = [];
	for (const line of sums.split("\n")) {
		const entry = /^([0-9a-fA-F]{64}) [ *](\S+)\s*$/.exec(line);
		if (entry?.[2] === binaryName) matches.push(entry[1].toLowerCase());
	}
	if (matches.length !== 1) {
		throw new Error(`Sprilicred SHA256SUMS.txt lists ${matches.length} entries for ${binaryName}`);
	}
	return matches[0];
}

async function fetchPublishedText(
	baseUrl: string,
	file: string,
	key: string,
	keyPath: string,
	fetchImpl: Fetch,
	timeoutMs: number,
): Promise<string> {
	const url = `${baseUrl}/omp/latest/${file}`;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${key}` },
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching ${url} after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw new Error(`Could not reach Sprilicred at ${baseUrl}: ${err instanceof Error ? err.message : err}`, {
			cause: err,
		});
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`Sprilicred rejected the key in ${keyPath} (HTTP ${response.status}); replace it with \`sprilicred-connect key\``,
		);
	}
	if (response.status === 404) {
		const reason = (await response.text()).trim();
		throw new Error(`Sprilicred has no published omp ${file}${reason ? `: ${reason}` : ""}`);
	}
	if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
	return await response.text();
}

/**
 * Read the release Sprilicred publishes for this platform, authenticated with
 * the key in `~/.sprilicred/user.key`.
 */
export async function getLatestRelease(
	options: { timeoutMs?: number; fetchImpl?: Fetch; baseUrl?: string; keyPath?: string; binaryName?: string } = {},
): Promise<PublishedRelease> {
	const keyPath = options.keyPath ?? sprilicredKeyPath();
	let key: string;
	try {
		key = (await fs.promises.readFile(keyPath, "utf8")).trim();
	} catch (err) {
		throw new Error(
			`No Sprilicred key at ${keyPath} (${(err as NodeJS.ErrnoException).code ?? err}); run the Sprilicred installer or \`${APP_NAME} login sprilicred\``,
		);
	}
	if (!key) throw new Error(`Sprilicred key file ${keyPath} is empty`);
	const baseUrl = options.baseUrl ?? sprilicredUrl();
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	const binaryName = options.binaryName ?? getBinaryName();
	const [tagText, sha256] = await Promise.all([
		fetchPublishedText(baseUrl, "VERSION", key, keyPath, fetchImpl, timeoutMs),
		// Only the same-version digest comparison needs the sums; a version check still works without them.
		fetchPublishedText(baseUrl, "SHA256SUMS.txt", key, keyPath, fetchImpl, timeoutMs).then(
			sums => parseChecksum(sums, binaryName),
			() => undefined,
		),
	]);
	const tag = tagText.trim();
	return { tag, version: parseReleaseTag(tag), sha256 };
}

/**
 * Whether the published release should replace the binary at `binaryPath`:
 * a newer omp version, or another Spring revision of the same version (told
 * apart by the binary digest, so unknowable without the published checksum).
 * A newer local version is never downgraded.
 */
export async function isUpdateAvailable(
	release: PublishedRelease,
	binaryPath: string = process.execPath,
	currentVersion: string = VERSION,
): Promise<boolean> {
	const comparison = compareVersions(release.version, currentVersion);
	if (comparison !== 0) return comparison > 0;
	if (release.sha256 === undefined) return false;
	try {
		const hash = new Bun.CryptoHasher("sha256");
		for await (const chunk of fs.createReadStream(binaryPath)) hash.update(chunk);
		return hash.digest("hex") !== release.sha256;
	} catch {
		// An unreadable or missing binary is never treated as the published one.
		return true;
	}
}

/** argv for running the Sprilicred installer for omp, answering yes to every question. */
export function buildInstallerCommand(baseUrl: string = sprilicredUrl()): string[] {
	return ["sh", "-c", INSTALLER_SCRIPT, "omp-update", baseUrl];
}

/** Environment for the installer: omp's launcher marker must not reach the installer's omp smoke run. */
export function buildInstallerEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
	const next: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && name !== "OMP_LAUNCHER_OWNS_CLI") next[name] = value;
	}
	return next;
}

/**
 * Run the update command: `--check` reports the published release; otherwise
 * the Sprilicred installer replaces omp.
 */
export async function runUpdateCommand(opts: { check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));
	if (opts.check) {
		let release: PublishedRelease;
		try {
			release = await getLatestRelease();
		} catch (err) {
			console.error(chalk.red(`Failed to check for updates: ${err instanceof Error ? err.message : err}`));
			process.exit(1);
		}
		const binaryPath = $which(APP_NAME) ?? process.execPath;
		if (await isUpdateAvailable(release, binaryPath)) {
			console.log(chalk.cyan(`New version available: ${release.tag}`));
			console.log(chalk.dim(`Run \`${APP_NAME} update\` to install it.`));
		} else if (release.sha256 === undefined && compareVersions(release.version, VERSION) === 0) {
			console.log(
				chalk.yellow(
					`Published release: ${release.tag}. Sprilicred listed no checksum for ${getBinaryName()}, so the installed Spring revision could not be compared; \`${APP_NAME} update\` reinstalls it.`,
				),
			);
		} else {
			const icon = theme?.status?.success ?? "✔";
			console.log(chalk.green(`${icon} Already up to date (${release.tag})`));
		}
		return;
	}
	console.log(chalk.dim(`Running the Sprilicred installer: ${sprilicredUrl()}/install.sh --clients omp --yes`));
	const installer = Bun.spawn(buildInstallerCommand(), {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: buildInstallerEnv(),
	});
	const exitCode = await installer.exited;
	if (exitCode !== 0) {
		console.error(chalk.red(`Update failed: the Sprilicred installer exited with code ${exitCode}`));
		process.exit(exitCode);
	}
}
