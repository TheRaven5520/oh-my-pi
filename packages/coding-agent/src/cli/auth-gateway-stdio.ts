/**
 * `omp auth-gateway stdio`: the gateway's routes as JSON lines on stdin and
 * stdout (`serveAuthGatewayStdio`), for a parent process that wants omp's
 * inference without an HTTP listener or a bearer token.
 *
 * Unlike `serve` it runs on this omp's own credentials (the broker when one is
 * configured, else the local store), models (`models.yml` and extension
 * providers included) and settings. A request's `model` is an omp model
 * selector, as `--model` takes it ({@link selectorModel}). Serving ends when
 * stdin does.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createAuthGatewayRouter, serveAuthGatewayStdio } from "@oh-my-pi/pi-ai/auth-gateway";
import { getProjectDir, isRecord, postmortem, VERSION } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, normalizeModelPatternList, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { claimRpcInput } from "../modes/rpc/rpc-input";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

/** Names the caller in the gateway's logs. */
const STDIO_PEER = "stdio";

/**
 * The model a request naming `selector` runs on: the model `--model` would pick
 * (the first entry of a comma list that resolves). Undefined when no entry resolves.
 */
export function selectorModel(
	selector: string,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): Model<Api> | undefined {
	for (const pattern of normalizeModelPatternList(selector)) {
		const { model } = resolveCliModel({ cliModel: pattern, modelRegistry: registry, settings });
		if (model) return model;
	}
	return undefined;
}

/** Serves the gateway on stdin/stdout until stdin ends, then exits. */
export async function runAuthGatewayStdio(): Promise<void> {
	// Claimed before extension discovery so no in-process module can read the protocol's input.
	const input = claimRpcInput();
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const storage = await discoverAuthStorage(undefined, { settings });
	const registry = new ModelRegistry(storage);
	await registry.refresh();
	await loadCliExtensionProviders(registry, settings, cwd);

	// Candidates are routed by their exact `provider/id[@upstream]`, so the
	// router only ever resolves a model this process picked for the request.
	const routed = new Map<string, Model<Api>>();
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: id => routed.get(id),
		listModels: () => registry.getAvailable(),
	});
	const route = async (req: Request): Promise<Response> => {
		// Unparseable bodies pass through for the route to reject in its own wire format.
		const body: unknown = req.body
			? await req
					.clone()
					.json()
					.catch(() => undefined)
			: undefined;
		if (!isRecord(body) || typeof body.model !== "string") return router.route(req, STDIO_PEER);
		const selector = body.model;
		const model = selectorModel(selector, settings, registry);
		if (!model) {
			return Response.json(
				{ error: { message: `No available model matches "${selector}"`, type: "invalid_request_error" } },
				{ status: 404 },
			);
		}
		const key = formatModelStringWithRouting(model);
		routed.set(key, model);
		const attempt = new Request(req.url, {
			method: req.method,
			headers: req.headers,
			body: JSON.stringify({ ...body, model: key }),
		});
		return router.route(attempt, STDIO_PEER);
	};

	try {
		await serveAuthGatewayStdio({ input, write: line => process.stdout.write(line), route, version: VERSION });
	} finally {
		router.close();
		storage.close();
	}
	// Idle provider sockets and settings timers would otherwise keep the process alive past stdin's end.
	await postmortem.quit(0);
}
