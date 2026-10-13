/**
 * State machine behind the /model hub's "Search <provider>…" scope: a query is
 * debounced, the previous request is aborted, and a sequence number drops any
 * late answer for an older query. Both hub render paths (line and native) read
 * {@link ModelSearchSession.state} and {@link ModelSearchSession.message}.
 */
import type { Model } from "@oh-my-pi/pi-ai";

/** A remote search hit: the model to show and an opaque host payload the pick writes. */
export interface ModelSearchHit {
	model: Model;
	entry: unknown;
}

export type ModelSearchFn = (query: string, signal: AbortSignal) => Promise<ModelSearchHit[]>;

export type ModelSearchState =
	| { status: "idle" }
	| { status: "loading"; query: string }
	| { status: "results"; query: string; hits: readonly ModelSearchHit[] }
	| { status: "empty"; query: string }
	| { status: "error"; query: string; message: string };

export const MODEL_SEARCH_DEBOUNCE_MS = 250;

export class ModelSearchSession {
	readonly label: string;
	#search: ModelSearchFn;
	#debounceMs: number;
	#onChange: () => void;
	#state: ModelSearchState = { status: "idle" };
	#query = "";
	#seq = 0;
	#timer: Timer | undefined;
	#controller: AbortController | undefined;

	constructor(label: string, search: ModelSearchFn, options: { onChange: () => void; debounceMs?: number }) {
		this.label = label;
		this.#search = search;
		this.#onChange = options.onChange;
		this.#debounceMs = options.debounceMs ?? MODEL_SEARCH_DEBOUNCE_MS;
	}

	get state(): ModelSearchState {
		return this.#state;
	}

	get hits(): readonly ModelSearchHit[] {
		return this.#state.status === "results" ? this.#state.hits : [];
	}

	/** Inline status for the results pane; undefined while results are listed. */
	message(): string | undefined {
		const state = this.#state;
		switch (state.status) {
			case "idle":
				return `Type to search ${this.label}`;
			case "loading":
				return `Searching ${this.label} for "${state.query}"…`;
			case "empty":
				return `No ${this.label} models match "${state.query}"`;
			case "error":
				return `Search failed: ${state.message}`;
			case "results":
				return undefined;
		}
	}

	/** Start (debounced) a search for `query`; an empty query clears the results. */
	setQuery(query: string): void {
		const trimmed = query.trim();
		if (trimmed === this.#query) return;
		this.#query = trimmed;
		const seq = ++this.#seq;
		this.#cancelPending();
		if (!trimmed) {
			this.#setState({ status: "idle" });
			return;
		}
		this.#setState({ status: "loading", query: trimmed });
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#run(trimmed, seq);
		}, this.#debounceMs);
	}

	dispose(): void {
		this.#seq++;
		this.#cancelPending();
	}

	async #run(query: string, seq: number): Promise<void> {
		const controller = new AbortController();
		this.#controller = controller;
		try {
			const hits = await this.#search(query, controller.signal);
			if (seq !== this.#seq) return;
			this.#setState(hits.length > 0 ? { status: "results", query, hits } : { status: "empty", query });
		} catch (error) {
			if (seq !== this.#seq) return;
			this.#setState({ status: "error", query, message: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this.#controller === controller) this.#controller = undefined;
		}
	}

	#cancelPending(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#controller?.abort();
		this.#controller = undefined;
	}

	#setState(state: ModelSearchState): void {
		this.#state = state;
		this.#onChange();
	}
}
