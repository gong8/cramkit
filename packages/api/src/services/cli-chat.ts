import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createLogger } from "@cramkit/shared";

const log = createLogger("api");

const BASE_TEMP_DIR = join(tmpdir(), "cramkit-cli");
const MCP_URL = process.env.CRAMKIT_MCP_URL || "http://127.0.0.1:3001/mcp";
const LLM_MODEL = process.env.LLM_MODEL || "claude-opus-4-6";

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- You are a study assistant. Only use MCP tools prefixed with mcp__cramkit__ to access study materials.",
	"- Never attempt to use filesystem, code editing, web browsing, or any non-MCP tools.",
	"- If you cannot find information via MCP tools, tell the student and offer your own knowledge as a supplement.",
	"- Never fabricate citations to materials. If you did not retrieve it from a tool, do not claim it is from their notes.",
	"- When you need to search for multiple topics or retrieve multiple resources, make all tool calls in parallel within a single response rather than sequentially.",
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

/** Max image dimension for vision — balances quality vs token cost */
const CLI_IMAGE_MAX_DIM = 1536;
const CLI_IMAGE_QUALITY = 80;

/** Create a per-invocation temp directory so concurrent streams never share files */
function createInvocationDir(): string {
	const dir = join(BASE_TEMP_DIR, randomUUID().slice(0, 12));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Resize images so the CLI's Read tool can process them (25k token limit).
 * Returns paths to resized copies in the invocation temp directory.
 */
async function resizeImagesForCli(images: string[], dir: string): Promise<string[]> {
	const resized: string[] = [];
	for (let i = 0; i < images.length; i++) {
		const outPath = join(dir, `image_${i}.jpg`);
		try {
			await sharp(images[i])
				.resize(CLI_IMAGE_MAX_DIM, CLI_IMAGE_MAX_DIM, { fit: "inside", withoutEnlargement: true })
				.jpeg({ quality: CLI_IMAGE_QUALITY })
				.toFile(outPath);
			resized.push(outPath);
		} catch (err) {
			log.warn(`Failed to resize image ${images[i]}: ${err}`);
			// Fall back to original — the CLI may still error, but at least we tried
			resized.push(images[i]);
		}
	}
	return resized;
}

function writeTempFile(dir: string, filename: string, content: string): string {
	const filePath = join(dir, filename);
	writeFileSync(filePath, content);
	return filePath;
}

/**
 * Generate a minimal MCP stdio server script that serves image files.
 * Only allows reading files whose paths are in the provided allowlist.
 * This is used instead of unblocking the Read tool, which the agent abuses
 * to read arbitrary files (including CLI overflow dumps).
 */
function writeImageViewerMcp(dir: string, allowedPaths: string[]): string {
	const allowedJson = JSON.stringify(allowedPaths);
	const script = `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const ALLOWED = new Set(${allowedJson});

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const id = req.id;
  switch (req.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "image-viewer", version: "1.0.0" },
      }});
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: [{
        name: "view_image",
        description: "View an attached image file. Returns the image for visual analysis.",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string", description: "Absolute path to the image file" } },
          required: ["file_path"],
        },
      }]}});
      break;
    case "tools/call": {
      const filePath = req.params?.arguments?.file_path;
      if (!filePath || !ALLOWED.has(path.resolve(filePath))) {
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: "Access denied: only attached images can be viewed." }],
          isError: true,
        }});
        break;
      }
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "image", data: data.toString("base64"), mimeType: mime }],
        }});
      } catch (err) {
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: "Error: " + err.message }],
          isError: true,
        }});
      }
      break;
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;
	return writeTempFile(dir, "image-viewer-mcp.js", script);
}

function writeMcpConfig(dir: string, imagePaths?: string[]): string {
	const servers: Record<string, unknown> = {
		cramkit: { type: "http", url: MCP_URL },
	};

	if (imagePaths && imagePaths.length > 0) {
		const scriptPath = writeImageViewerMcp(dir, imagePaths);
		servers.images = {
			type: "stdio",
			command: "node",
			args: [scriptPath],
		};
	}

	return writeTempFile(dir, "mcp-config.json", JSON.stringify({ mcpServers: servers }));
}

function writeSystemPrompt(dir: string, content: string): string {
	return writeTempFile(dir, "system-prompt.txt", content + SYSTEM_PROMPT_SUFFIX);
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
	images?: string[];
}

export interface ToolCallData {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

function buildPrompt(messages: CliMessage[], images?: string[]): string {
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

	// When images are attached, instruct the model to view them using the MCP image viewer
	if (images && images.length > 0) {
		const imageList = images.map((p) => `  - ${p}`).join("\n");
		parts.push(
			[
				"<attached_images>",
				"The user has attached images to this conversation. Use the mcp__images__view_image tool to view each image:",
				imageList,
				"</attached_images>",
			].join("\n"),
		);
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
		"--include-partial-messages",
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

type BlockType = "text" | "tool_use" | "thinking";

interface StreamParser {
	process(msg: Record<string, unknown>): void;
}

/**
 * Creates a stateful stream parser that handles content_block_start/delta/stop
 * events for text, tool_use, and thinking blocks.
 *
 * Emits structured SSE events via the provided emit function.
 */
function createStreamParser(emitSSE: (event: string, data: string) => void): StreamParser {
	const blockTypes = new Map<number, BlockType>();
	const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();
	const thinkingText = new Map<number, string>();

	function processToolResults(message: Record<string, unknown>): void {
		const content = message.content as Array<Record<string, unknown>> | undefined;
		if (!content) return;
		for (const block of content) {
			if (block.type === "tool_result") {
				const toolUseId = block.tool_use_id as string;
				const isError = block.is_error === true;
				let resultText = "";
				const blockContent = block.content as
					| string
					| Array<Record<string, unknown>>
					| undefined;
				if (typeof blockContent === "string") {
					resultText = blockContent;
				} else if (Array.isArray(blockContent)) {
					resultText = blockContent.map((c) => (c.text as string) || "").join("");
				}
				emitSSE(
					"tool_result",
					JSON.stringify({
						toolCallId: toolUseId,
						result: resultText,
						isError,
					}),
				);
			}
		}
	}

	function process(msg: Record<string, unknown>): void {
		// Handle top-level "user" messages containing tool_result blocks
		// These are emitted by the CLI outside of stream_event wrappers
		if (msg.type === "user") {
			const message = msg.message as Record<string, unknown> | undefined;
			if (message?.role === "user") {
				processToolResults(message);
			}
			return;
		}

		if (msg.type !== "stream_event") return;
		const event = msg.event as Record<string, unknown> | undefined;
		if (!event) return;

		switch (event.type) {
			case "content_block_start": {
				const index = event.index as number;
				const block = event.content_block as Record<string, unknown> | undefined;
				if (!block) break;

				const blockType = block.type as string;
				if (blockType === "tool_use") {
					blockTypes.set(index, "tool_use");
					const toolCallId = (block.id as string) || `tool_${index}`;
					const toolName = (block.name as string) || "unknown";
					toolCalls.set(index, { id: toolCallId, name: toolName, argsJson: "" });
					emitSSE("tool_call_start", JSON.stringify({ toolCallId, toolName }));
				} else if (blockType === "thinking") {
					blockTypes.set(index, "thinking");
					thinkingText.set(index, "");
					emitSSE("thinking_start", JSON.stringify({}));
				} else {
					blockTypes.set(index, "text");
				}
				break;
			}

			case "content_block_delta": {
				const index = event.index as number;
				const delta = event.delta as Record<string, unknown> | undefined;
				if (!delta) break;

				const deltaType = delta.type as string;
				const blockType = blockTypes.get(index);

				if (deltaType === "text_delta" && delta.text) {
					if (blockType === "text") {
						emitSSE("content", JSON.stringify({ content: delta.text as string }));
					}
					// Ignore text_delta for other block types
				} else if (deltaType === "input_json_delta" && delta.partial_json !== undefined) {
					// Accumulate tool call args JSON
					const tc = toolCalls.get(index);
					if (tc) {
						tc.argsJson += delta.partial_json as string;
					}
				} else if (deltaType === "thinking_delta" && delta.thinking) {
					const prev = thinkingText.get(index) || "";
					thinkingText.set(index, prev + (delta.thinking as string));
					emitSSE("thinking_delta", JSON.stringify({ text: delta.thinking as string }));
				}
				break;
			}

			case "content_block_stop": {
				const index = event.index as number;
				const blockType = blockTypes.get(index);

				if (blockType === "tool_use") {
					const tc = toolCalls.get(index);
					if (tc) {
						let args: Record<string, unknown> = {};
						try {
							args = tc.argsJson ? JSON.parse(tc.argsJson) : {};
						} catch {
							log.warn(`Failed to parse tool call args for ${tc.name}`);
						}
						emitSSE(
							"tool_call_args",
							JSON.stringify({ toolCallId: tc.id, toolName: tc.name, args }),
						);
					}
				}
				break;
			}

			// Handle tool results from stream_event message_start with role "user"
			case "message_start": {
				const message = event.message as Record<string, unknown> | undefined;
				if (message?.role === "user") {
					processToolResults(message);
				}
				break;
			}
		}
	}

	return { process };
}

/**
 * Spawn the Claude CLI with MCP tools and stream the response.
 * Emits structured SSE events for text, tool calls, thinking, and results.
 */
export function streamCliChat(options: CliChatOptions): ReadableStream<Uint8Array> {
	const invocationDir = createInvocationDir();
	const systemPromptPath = writeSystemPrompt(invocationDir, options.systemPrompt);
	const model = getCliModel(options.model ?? LLM_MODEL);
	const hasImages = options.images && options.images.length > 0;

	return new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			// Resize images for CLI consumption (must happen before building prompt)
			let cliImagePaths = options.images;
			if (hasImages) {
				cliImagePaths = await resizeImagesForCli(options.images!, invocationDir);
			}

			// Write MCP config — includes image viewer MCP server when images are attached
			const mcpConfigPath = writeMcpConfig(invocationDir, cliImagePaths);

			const prompt =
				buildPrompt(options.messages, cliImagePaths) || (hasImages ? "Describe this image." : "");

			// All builtin tools stay blocked — images are served via MCP, not Read
			const args = buildCliArgs(model, mcpConfigPath, systemPromptPath, BLOCKED_BUILTIN_TOOLS, prompt);

			const startMs = performance.now();
			log.info(`cli-chat START — model=${model} mcp=${MCP_URL} prompt=${prompt.length} chars`);

			function emitSSE(event: string, data: string): void {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			}

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawn("claude", args, {
					cwd: invocationDir,
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

			const parser = createStreamParser(emitSSE);
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

					parser.process(msg);

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

			function cleanupTempDir() {
				try {
					rmSync(invocationDir, { recursive: true, force: true });
				} catch {
					// best-effort cleanup
				}
			}

			proc.on("close", (code) => {
				const elapsed = (performance.now() - startMs).toFixed(0);
				log.info(`cli-chat process exited code=${code} elapsed=${elapsed}ms`);
				tryClose();
				cleanupTempDir();
			});

			proc.on("error", (err) => {
				log.error(`cli-chat process error: ${err.message}`);
				emitSSE("error", JSON.stringify({ error: err.message }));
				tryClose();
				cleanupTempDir();
			});
		},
	});
}
