export class CancellationError extends Error {
	constructor(message = "Operation cancelled") {
		super(message);
		this.name = "CancellationError";
	}
}

/** Detects Anthropic API 500/529 errors in CLI output */
export function isApiServerError(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error);
	return /API Error: (5\d{2})\b/.test(msg);
}

/** Sleep that respects AbortSignal */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new CancellationError("Sleep cancelled"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new CancellationError("Sleep cancelled"));
			},
			{ once: true },
		);
	});
}
