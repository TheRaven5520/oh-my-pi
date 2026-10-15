import { register } from "../config/registry";

/** SSH destinations are explicit and never discovered by scanning the network. */
export const cfgCentralHosts = register({
	id: "central.hosts",
	type: "array",
	default: [] as string[],
});

export const cfgCentralIdentity = register({
	id: "central.identity",
	type: "string",
	default: "",
});

