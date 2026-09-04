import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

const TOKEN = "reset-credit-test-token";
const authorized = { Authorization: `Bearer ${TOKEN}` };

type RedeemResetCredit = AuthStorage["redeemResetCredit"];

/** Narrow a response body once, at the boundary, so field reads are checked. */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	const body: unknown = await response.json();
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error(`expected a JSON object body, got ${JSON.stringify(body)}`);
	}
	// Checked immediately above: non-null, non-array object.
	const record = body as Record<string, unknown>;
	return record;
}

async function withGateway(
	run: (context: { url: string; storage: AuthStorage }) => Promise<void>,
	bearerTokens: string[] = [TOKEN],
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-reset-credits-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens,
		storage,
		resolveModel: () => undefined,
		version: "test",
	});
	try {
		await run({ url: handle.url, storage });
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function redeem(url: string, body: string, headers: Record<string, string> = authorized): Promise<Response> {
	return fetch(`${url}/v1/usage/reset-credits/redeem`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body,
	});
}

test("saved-reset inventory requires a bearer token", async () => {
	await withGateway(async ({ url }) => {
		const unauthorized = await fetch(`${url}/v1/usage/reset-credits`);
		expect(unauthorized.status).toBe(401);
		expect(await readJsonObject(unauthorized)).toEqual({ error: "unauthorized" });
	});
});

test("saved-reset inventory answers with an envelope and leaks no token material", async () => {
	await withGateway(async ({ url }) => {
		// No stored OAuth rows: the endpoint must still answer so a caller can
		// distinguish "no accounts" from "endpoint missing".
		const response = await fetch(`${url}/v1/usage/reset-credits`, { headers: authorized });
		expect(response.status).toBe(200);
		const body = await readJsonObject(response);
		expect(typeof body.generatedAt).toBe("number");
		expect(body.accounts).toEqual([]);
		expect(JSON.stringify(body)).not.toInclude("accessToken");
	});
});

test("redeem requires a bearer token", async () => {
	await withGateway(async ({ url }) => {
		const response = await redeem(url, JSON.stringify({ credentialId: 1 }), {});
		expect(response.status).toBe(401);
	});
});

test("redeem rejects malformed bodies before reaching storage", async () => {
	await withGateway(async ({ url, storage }) => {
		let calls = 0;
		const counting: RedeemResetCredit = async () => {
			calls += 1;
			return { ok: true, code: "reset" };
		};
		storage.redeemResetCredit = counting;
		const cases: Array<{ body: string; error: string }> = [
			{ body: "not json", error: "invalid JSON body" },
			{ body: JSON.stringify([1]), error: "credentialId must be a positive integer" },
			{ body: JSON.stringify({}), error: "credentialId must be a positive integer" },
			{ body: JSON.stringify({ credentialId: 0 }), error: "credentialId must be a positive integer" },
			{ body: JSON.stringify({ credentialId: -3 }), error: "credentialId must be a positive integer" },
			{ body: JSON.stringify({ credentialId: 1.5 }), error: "credentialId must be a positive integer" },
			{ body: JSON.stringify({ credentialId: "1" }), error: "credentialId must be a positive integer" },
			{ body: JSON.stringify({ credentialId: 1, creditId: "" }), error: "creditId must be a non-empty string" },
			{
				body: JSON.stringify({ credentialId: 1, redeemRequestId: "nope!" }),
				error: "redeemRequestId must be a uuid-shaped string",
			},
		];
		for (const testCase of cases) {
			const response = await redeem(url, testCase.body);
			expect(response.status).toBe(400);
			expect(await readJsonObject(response)).toEqual({ error: testCase.error });
		}
		expect(calls).toBe(0);
	});
});

test("redeem reports an unknown credential id as 404 no_account", async () => {
	await withGateway(async ({ url }) => {
		const response = await redeem(url, JSON.stringify({ credentialId: 4242, redeemRequestId: crypto.randomUUID() }));
		expect(response.status).toBe(404);
		const body = await readJsonObject(response);
		expect(body.ok).toBe(false);
		expect(body.code).toBe("no_account");
	});
});

test("redeem targets only credentialId and forwards the client idempotency key", async () => {
	await withGateway(async ({ url, storage }) => {
		const targets: unknown[] = [];
		const keys: Array<string | undefined> = [];
		const capturing: RedeemResetCredit = async options => {
			targets.push(options.target);
			keys.push(options.redeemRequestId);
			return { ok: true, code: "reset", creditId: options.creditId ?? "RateLimitResetCredit_auto" };
		};
		storage.redeemResetCredit = capturing;
		const redeemRequestId = crypto.randomUUID();
		const response = await redeem(
			url,
			// email/accountId in the body must be ignored: redeemResetCredit ORs its
			// target fields, so honouring them could spend the wrong account.
			JSON.stringify({
				credentialId: 7,
				creditId: "RateLimitResetCredit_abc",
				redeemRequestId,
				email: "someone-else@example.com",
				accountId: "acct_other",
			}),
		);
		expect(response.status).toBe(200);
		expect(await readJsonObject(response)).toEqual({
			ok: true,
			code: "reset",
			creditId: "RateLimitResetCredit_abc",
		});
		expect(targets).toEqual([{ credentialId: 7 }]);
		expect(keys).toEqual([redeemRequestId]);
	});
});

test("redeem maps spent, missing, and upstream outcomes to distinct statuses", async () => {
	await withGateway(async ({ url, storage }) => {
		const outcomes: Array<[string, number]> = [
			["already_redeemed", 409],
			["no_credit", 409],
			["nothing_to_reset", 409],
			["credit_list_failed", 502],
			["account_unavailable", 503],
			["http_500", 502],
		];
		for (const [code, status] of outcomes) {
			const fixed: RedeemResetCredit = async () => ({ ok: false, code });
			storage.redeemResetCredit = fixed;
			const response = await redeem(url, JSON.stringify({ credentialId: 7 }));
			expect(response.status).toBe(status);
			expect((await readJsonObject(response)).code).toBe(code);
		}
	});
});

test("redeem answers a transport rejection with 502 rather than 500", async () => {
	await withGateway(async ({ url, storage }) => {
		const throwing: RedeemResetCredit = async () => {
			throw new Error("socket hang up");
		};
		storage.redeemResetCredit = throwing;
		const response = await redeem(url, JSON.stringify({ credentialId: 7 }));
		expect(response.status).toBe(502);
		expect(await readJsonObject(response)).toEqual({ ok: false, code: "redeem_failed" });
	});
});
