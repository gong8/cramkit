export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug: (message: string, ...args: unknown[]) => void;
	info: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;
	error: (message: string, ...args: unknown[]) => void;
}

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createLogger(prefix: string): Logger {
	const fmt = (level: string, message: string) =>
		`[${timestamp()}] [${level}] [${prefix}] ${message}`;

	return {
		debug: (message, ...args) => console.error(fmt("DEBUG", message), ...args),
		info: (message, ...args) => console.error(fmt("INFO", message), ...args),
		warn: (message, ...args) => console.warn(fmt("WARN", message), ...args),
		error: (message, ...args) => console.error(fmt("ERROR", message), ...args),
	};
}
