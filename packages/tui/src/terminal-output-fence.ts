/** One ordered DSR fence; a timed-out reply must drain before another can be armed. */
export class TerminalOutputFence {
	#pending: ((accepted: boolean) => void) | undefined;
	#awaitingReply = false;

	constructor(
		private readonly write: (data: string) => void,
		private readonly timeoutMs = 2000,
	) {}

	wait(signal?: AbortSignal): Promise<boolean> {
		if (this.#awaitingReply || signal?.aborted) return Promise.resolve(false);
		this.#awaitingReply = true;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const abort = () => this.#pending?.(false);
		const timer = setTimeout(abort, this.timeoutMs);
		this.#pending = accepted => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.#pending = undefined;
			resolve(accepted);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			this.write("\x1b[5n");
		} catch {
			this.#pending?.(false);
		}
		return promise;
	}

	/** ProcessTerminal's StdinBuffer assembles CSI replies before dispatch. */
	consume(data: string): string {
		if (!this.#awaitingReply || data.startsWith("\x1b[200~")) return data;
		const reply = "\x1b[0n";
		const index = data.indexOf(reply);
		if (index < 0) return data;
		this.#awaitingReply = false;
		this.#pending?.(true);
		return data.slice(0, index) + data.slice(index + reply.length);
	}

	cancel(): void {
		this.#pending?.(false);
	}
}
