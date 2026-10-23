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

/** `omp central --focus`: coordinator mailbox executable behind `/send` and `/inbox`. Empty: not configured. */
export const cfgCentralFocusHqmsg = register({
	id: "central.focus.hqmsg",
	type: "string",
	default: "",
});

/** `omp central --focus`: file whose presence pauses coordinator inbox steering (`/pause`, `/resume`). */
export const cfgCentralFocusPauseFile = register({
	id: "central.focus.pauseFile",
	type: "string",
	default: "",
});

/** `omp central --focus`: task board URL printed by `/dag`. */
export const cfgCentralFocusBoardUrl = register({
	id: "central.focus.boardUrl",
	type: "string",
	default: "",
});
