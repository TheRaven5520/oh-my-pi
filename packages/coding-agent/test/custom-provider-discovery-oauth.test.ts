import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// A Claude-Code-style gateway (e.g. Sprilicred) serves Claude through an
// `anthropic-messages` provider with `auth: oauth`: every request must carry the
// OAuth (Claude Code) shape. Discovery used to build its rows without that flag
// and, once it listed a models.yml row too, the merged row lost it as well.
describe("models.yml discovery keeps the provider's OAuth request shape", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-discovery-oauth-"));
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function writeGateway(auth: "oauth" | undefined): void {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "https://gateway.example/anthropic",
						apiKey: "gateway-key",
						...(auth ? { auth } : {}),
						authHeader: true,
						api: "anthropic-messages",
						discovery: { type: "openai-models-list" },
						models: [{ id: "claude-listed", contextWindow: 200000, maxTokens: 64000 }],
					},
				},
			}),
		);
	}

	const listing = async (input: string | URL | Request) => {
		expect(String(input)).toBe("https://gateway.example/anthropic/v1/models");
		return Response.json({ data: [{ id: "claude-listed" }, { id: "claude-new" }] });
	};

	test("auth: oauth shapes listed and discovered models, live and from the cache", async () => {
		writeGateway("oauth");
		const live = new ModelRegistry(authStorage, modelsPath, { fetch: listing });
		await live.refreshProvider("gateway", "online");
		expect(live.find("gateway", "claude-listed")?.isOAuth).toBe(true);
		expect(live.find("gateway", "claude-new")?.isOAuth).toBe(true);

		// Next process: the rows come from models.db, which never stores the flag.
		const cached = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(cached.find("gateway", "claude-listed")?.isOAuth).toBe(true);
		expect(cached.find("gateway", "claude-new")?.isOAuth).toBe(true);
	});

	test("a listed anthropic-messages row keeps its default OAuth shape once discovery lists it", async () => {
		writeGateway(undefined);
		const live = new ModelRegistry(authStorage, modelsPath, { fetch: listing });
		expect(live.find("gateway", "claude-listed")?.isOAuth).toBe(true);
		await live.refreshProvider("gateway", "online");
		expect(live.find("gateway", "claude-new")).toBeDefined();
		expect(live.find("gateway", "claude-listed")?.isOAuth).toBe(true);
	});
});
