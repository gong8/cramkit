import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "@cramkit/shared";
import type { Logger } from "@cramkit/shared";

const PHASE_NAMES: Record<number, string> = {
	1: "content-processing",
	2: "graph-indexing",
	3: "cross-linking",
	4: "graph-cleanup",
	5: "metadata-extraction",
};

const LOGS_BASE_DIR = resolve(process.cwd(), "data", "indexer-logs");

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dirTimestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function formatArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (a instanceof Error) {
				return a.stack ?? `${a.name}: ${a.message}`;
			}
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a, null, 2);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

/**
 * File-writing logger for indexer batch runs.
 * Creates a timestamped directory per batch with per-phase log files,
 * a combined batch.log, and an agents/ subdirectory for subprocess output.
 *
 * Implements the Logger interface so it can be used anywhere a Logger is expected.
 * All output is also forwarded to the console via createLogger.
 */
export class IndexerLogger implements Logger {
	private readonly console: Logger;
	private readonly logDir!: string;
	private readonly agentsDir!: string;
	private batchStream: WriteStream | null = null;
	private phaseStream: WriteStream | null = null;
	private currentPhase: number | null = null;
	private readonly streams: WriteStream[] = [];
	private enabled = true;

	constructor(
		public readonly batchId: string,
		public readonly sessionId: string,
	) {
		this.console = createLogger("indexer");

		try {
			const dirName = `${dirTimestamp()}_${batchId.slice(0, 8)}`;
			this.logDir = join(LOGS_BASE_DIR, dirName);
			this.agentsDir = join(this.logDir, "agents");
			mkdirSync(this.agentsDir, { recursive: true });

			this.batchStream = createWriteStream(join(this.logDir, "batch.log"), { flags: "a" });
			this.streams.push(this.batchStream);
		} catch (err) {
			this.enabled = false;
			this.console.warn(
				`IndexerLogger — failed to create log directory, falling back to console-only: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** The directory where logs for this batch are stored. */
	get dir(): string {
		return this.logDir;
	}

	startPhase(phase: number): void {
		this.endPhase();
		this.currentPhase = phase;
		const name = PHASE_NAMES[phase] ?? `phase${phase}`;

		if (this.enabled) {
			try {
				const phaseFile = join(this.logDir, `phase${phase}-${name}.log`);
				this.phaseStream = createWriteStream(phaseFile, { flags: "a" });
				this.streams.push(this.phaseStream);
			} catch {
				// non-fatal — phase file just won't be written
			}
		}

		this.info(`═══ Phase ${phase}: ${name} ═══`);
	}

	endPhase(): void {
		if (this.currentPhase !== null) {
			this.info(`═══ End Phase ${this.currentPhase} ═══`);
		}
		if (this.phaseStream) {
			this.phaseStream.end();
			this.phaseStream = null;
		}
		this.currentPhase = null;
	}

	/**
	 * Returns file paths for capturing agent subprocess stdout/stderr.
	 * Caller is responsible for creating WriteStreams and piping data.
	 */
	getAgentLogPaths(
		agentName: string,
		resourceName?: string,
	): { stdoutPath: string; stderrPath: string } | null {
		if (!this.enabled) return null;

		const safeName = resourceName
			? `${agentName}_${resourceName.replace(/[^a-zA-Z0-9_-]/g, "-")}`
			: agentName;

		return {
			stdoutPath: join(this.agentsDir, `${safeName}_stdout.log`),
			stderrPath: join(this.agentsDir, `${safeName}_stderr.log`),
		};
	}

	debug(message: string, ...args: unknown[]): void {
		this.console.debug(message, ...args);
		this.writeLine("DEBUG", message, args);
	}

	info(message: string, ...args: unknown[]): void {
		this.console.info(message, ...args);
		this.writeLine("INFO", message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.console.warn(message, ...args);
		this.writeLine("WARN", message, args);
	}

	error(message: string, ...args: unknown[]): void {
		this.console.error(message, ...args);
		this.writeLine("ERROR", message, args);
	}

	close(): void {
		this.endPhase();
		for (const stream of this.streams) {
			try {
				stream.end();
			} catch {
				// best-effort
			}
		}
		this.streams.length = 0;
		this.batchStream = null;
	}

	private writeLine(level: string, message: string, args: unknown[]): void {
		if (!this.enabled) return;

		const argsStr = args.length > 0 ? ` ${formatArgs(args)}` : "";
		const line = `[${timestamp()}] [${level}] ${message}${argsStr}\n`;

		this.batchStream?.write(line);
		this.phaseStream?.write(line);
	}
}
