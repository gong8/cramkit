import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createLogger } from "@cramkit/shared";

const log = createLogger("api");

const TEMP_DIR = join(tmpdir(), `cramkit-cli-${randomUUID().slice(0, 8)}`);
const MCP_URL = process.env.CRAMKIT_MCP_URL || "http://127.0.0.1:3001/mcp";
const LLM_MODEL = process.env.LLM_MODEL || "claude-opus-4-6";

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT: You are a study assistant chatbot, NOT a coding agent.",
	"You MUST only use the MCP tools (prefixed with mcp__cramkit__) to look up study material and answer questions.",
	"NEVER attempt to use code tools like Bash, Read, Write, Edit, Glob, Grep, or any tool not prefixed with mcp__cramkit__.",
	"If data is not available via MCP tools, say so and use your own knowledge instead. Do not try to access the filesystem or codebase.",
].join("\n");

const BLOCKED_BUILTIN_TOOLS = [
	"Bash",
	"Read",
	"Write",
	"Edit",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"Task",
	"TaskOutput",
	"NotebookEdit",
	"EnterPlanMode",
	"ExitPlanMode",
	"TodoWrite",
	"AskUserQuestion",
	"Skill",
	"TeamCreate",
	"TeamDelete",
	"SendMessage",
	"TaskStop",
	"ToolSearch",
];

function getCliModel(model: string): string {
	if (model.includes("opus")) return "opus";
	if (model.includes("haiku")) return "haiku";
	return "sonnet";
}

function writeTempFile(filename: string, content: string): string {
	mkdirSync(TEMP_DIR, { recursive: true });
	const filePath = join(TEMP_DIR, filename);
	writeFileSync(filePath, content);
	return filePath;
}

function writeMcpConfig(): string {
	return writeTempFile(
		"mcp-config.json",
		JSON.stringify({ mcpServers: { cramkit: { type: "http", url: MCP_URL } } }),
	);
}

function writeSystemPrompt(content: string): string {
	return writeTempFile("system-prompt.txt", content + SYSTEM_PROMPT_SUFFIX);
}

interface CliMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface CliChatOptions {
	messages: CliMessage[];
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
}

function buildPrompt(messages: CliMessage[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		switch (msg.role) {
			case "system":
				break;
			case "assistant":
				parts.push(`<previous_response>\n${msg.content}\n</previous_response>`);
				break;
			case "user":
				parts.push(msg.content);
				break;
		}
	}

	return parts.join("\n\n").trim();
}

function buildCliArgs(
	model: string,
	mcpConfigPath: string,
	systemPromptPath: string,
	disallowedTools: string[],
	prompt: string,
): string[] {
	return [
		"--print",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		model,
		"--dangerously-skip-permissions",
		"--mcp-config",
		mcpConfigPath,
		"--strict-mcp-config",
		"--disallowedTools",
		...disallowedTools,
		"--append-system-prompt-file",
		systemPromptPath,
		"--setting-sources",
		"",
		"--no-session-persistence",
		"--max-turns",
		"50",
		prompt,
	];
}

function extractTextDelta(msg: Record<string, unknown>): string | null {
	if (msg.type !== "stream_event") return null;
	const event = msg.event as Record<string, unknown> | undefined;
	if (event?.type !== "content_block_delta") return null;
	const delta = event.delta as Record<string, unknown> | undefined;
	if (delta?.type !== "text_delta" || !delta.text) return null;
	return delta.text as string;
}

/**
 * Spawn the Claude CLI with MCP tools and stream the response.
 * Emits SSE events: { content: string } for text, "[DONE]" when finished.
 */
export function streamCliChat(options: CliChatOptions): ReadableStream<Uint8Array> {
	const mcpConfigPath = writeMcpConfig();
	const systemPromptPath = writeSystemPrompt(options.systemPrompt);
	const model = getCliModel(options.model ?? LLM_MODEL);
	const prompt = buildPrompt(options.messages);
	const args = buildCliArgs(model, mcpConfigPath, systemPromptPath, BLOCKED_BUILTIN_TOOLS, prompt);

	const startMs = performance.now();
	log.info(`cli-chat START — model=${model} mcp=${MCP_URL} prompt=${prompt.length} chars`);

	return new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			function emitSSE(event: string, data: string): void {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			}

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawn("claude", args, {
					cwd: TEMP_DIR,
					env: {
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						SHELL: process.env.SHELL,
						TERM: process.env.TERM,
					},
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Unknown spawn error";
				log.error(`cli-chat spawn failed: ${msg}`);
				emitSSE("error", JSON.stringify({ error: msg }));
				emitSSE("done", "[DONE]");
				controller.close();
				return;
			}

			proc.stdin?.end();
			log.info(`cli-chat PID: ${proc.pid}`);

			if (options.signal) {
				options.signal.addEventListener("abort", () => {
					log.info(`cli-chat abort signal, killing PID ${proc.pid}`);
					proc.kill("SIGTERM");
				});
			}

			let buffer = "";
			let closed = false;

			const tryClose = (): void => {
				if (closed) return;
				closed = true;
				emitSSE("done", "[DONE]");
				controller.close();
			};

			proc.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let msg: Record<string, unknown>;
					try {
						msg = JSON.parse(trimmed);
					} catch {
						continue;
					}

					const text = extractTextDelta(msg);
					if (text) {
						emitSSE("content", JSON.stringify({ content: text }));
					}

					if (msg.type === "result") {
						const elapsed = (performance.now() - startMs).toFixed(0);
						const cost = msg.cost_usd ? `$${(msg.cost_usd as number).toFixed(4)}` : "n/a";
						log.info(`cli-chat DONE — ${elapsed}ms, ${msg.num_turns ?? "?"} turns, cost=${cost}`);
					}
				}
			});

			proc.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString().trim();
				if (text) log.warn(`cli-chat stderr: ${text.slice(0, 300)}`);
			});

			proc.on("close", (code) => {
				const elapsed = (performance.now() - startMs).toFixed(0);
				log.info(`cli-chat process exited code=${code} elapsed=${elapsed}ms`);
				tryClose();
			});

			proc.on("error", (err) => {
				log.error(`cli-chat process error: ${err.message}`);
				emitSSE("error", JSON.stringify({ error: err.message }));
				tryClose();
			});
		},
	});
}
