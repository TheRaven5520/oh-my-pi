import * as path from "node:path";
import { AuthStorage, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { refreshOAuthToken } from "@oh-my-pi/pi-ai/oauth";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

export function accountSource(provider: string): "anthropic" | "openai-codex" | undefined {
	if (provider.startsWith("account-claude-")) return "anthropic";
	if (provider.startsWith("account-chatgpt-")) return "openai-codex";
	return undefined;
}

/** A separate instance of the local credential store, never opened by broker serve/migrate. */
export function accountDbPath(agentDir?: string) {
	return path.join(path.dirname(getAgentDbPath(agentDir)), "accounts.db");
}

export async function withAccountStore<T>(dbPath: string, fn: (storage: AuthStorage) => T | Promise<T>): Promise<T> {
	const storage = await AuthStorage.create(dbPath);
	try {
		await storage.credentials.reload();
		return await fn(storage);
	} finally {
		storage.close();
	}
}

export function listAccounts(storage: AuthStorage) {
	return storage.credentials.list().flatMap(({ provider, credential }) => {
		const source = accountSource(provider);
		return source && credential.type === "oauth" && credential.accountLabel
			? [{ provider, source, label: credential.accountLabel }]
			: [];
	});
}

export async function loadAccountModels(dbPath: string) {
	if (!(await Bun.file(dbPath).exists())) return [];
	return withAccountStore(dbPath, storage =>
		listAccounts(storage).flatMap(({ provider, source, label }) =>
			// Copy the *bundled upstream* endpoint, never a configurable base URL or header override.
			getBundledModels(source).map(model => ({
				...model,
				provider,
				isOAuth: true,
				name: `${model.name} via ${label}`,
			})),
		),
	);
}

export async function getAccountKey(
	dbPath: string,
	provider: string,
	options?: { forceRefresh?: boolean; signal?: AbortSignal },
) {
	const source = accountSource(provider);
	if (!source || !(await Bun.file(dbPath).exists())) return undefined;
	return withAccountStore(dbPath, async storage => {
		const { credential } = await storage.oauth.refreshStored(provider, {
			credentialFromRow: (row: OAuthCredential) => (row.accountLabel ? row : undefined),
			forceRefresh: options?.forceRefresh,
			signal: options?.signal,
			refresh: (current, signal) => refreshOAuthToken(source, current, signal),
		});
		return credential?.access;
	});
}
