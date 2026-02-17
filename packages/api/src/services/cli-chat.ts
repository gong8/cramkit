import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@cramkit/shared";
import sharp from "sharp";
import { LineBuffer } from "./line-buffer.js";

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

const CLI_IMAGE_MAX_DIM = 1536;
const CLI_IMAGE_QUALITY = 80;

function createInvocationDir(): string {
	const dir = join(BASE_TEMP_DIR, randomUUID().slice(0, 12));
	mkdirSync(dir, { recursive: true });
	return dir;
}

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
	/** All images in the conversation (for MCP tool access). */
	images?: string[];
	/** Only images attached to the latest user message (for prompt instruction). */
	newImages?: string[];
}

export interface ToolCallData {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

function buildPrompt(messages: CliMessage[], newImages?: string[]): string {
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

	if (newImages && newImages.length > 0) {
		const imageList = newImages.map((p) => `  - ${p}`).join("\n");
		parts.push(
			[
				"<attached_images>",
				"The user has attached new images. Use the mcp__images__view_image tool to view each image:",
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

type SSEEmitter = (event: string, data: string) => void;

function extractToolResultText(
	blockContent: string | Array<Record<string, unknown>> | undefined,
): string {
	if (typeof blockContent === "string") return blockContent;
	if (Array.isArray(blockContent)) {
		return blockContent.map((c) => (c.text as string) || "").join("");
	}
	return "";
}

function emitToolResultsFromContent(
	content: Array<Record<string, unknown>> | undefined,
	emitSSE: SSEEmitter,
): void {
	if (!content) return;
	for (const block of content) {
		if (block.type !== "tool_result") continue;
		emitSSE(
			"tool_result",
			JSON.stringify({
				toolCallId: block.tool_use_id as string,
				result: extractToolResultText(
					block.content as string | Array<Record<string, unknown>> | undefined,
				),
				isError: block.is_error === true,
			}),
		);
	}
}

function emitUserToolResults(msg: Record<string, unknown>, emitSSE: SSEEmitter): void {
	const message = msg.message as Record<string, unknown> | undefined;
	if (message?.role === "user") {
		emitToolResultsFromContent(
			message.content as Array<Record<string, unknown>> | undefined,
			emitSSE,
		);
	}
}

function createStreamParser(emitSSE: SSEEmitter) {
	const blockTypes = new Map<number, BlockType>();
	const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();

	function handleBlockStart(index: number, block: Record<string, unknown>): void {
		const blockType = block.type as string;
		if (blockType === "tool_use") {
			blockTypes.set(index, "tool_use");
			const toolCallId = (block.id as string) || `tool_${index}`;
			const toolName = (block.name as string) || "unknown";
			toolCalls.set(index, { id: toolCallId, name: toolName, argsJson: "" });
			emitSSE("tool_call_start", JSON.stringify({ toolCallId, toolName }));
		} else if (blockType === "thinking") {
			blockTypes.set(index, "thinking");
			emitSSE("thinking_start", JSON.stringify({}));
		} else {
			blockTypes.set(index, "text");
		}
	}

	function handleBlockDelta(index: number, delta: Record<string, unknown>): void {
		const deltaType = delta.type as string;
		const blockType = blockTypes.get(index);

		if (deltaType === "text_delta" && delta.text && blockType === "text") {
			emitSSE("content", JSON.stringify({ content: delta.text as string }));
		} else if (deltaType === "input_json_delta" && delta.partial_json !== undefined) {
			const tc = toolCalls.get(index);
			if (tc) tc.argsJson += delta.partial_json as string;
		} else if (deltaType === "thinking_delta" && delta.thinking) {
			emitSSE("thinking_delta", JSON.stringify({ text: delta.thinking as string }));
		}
	}

	function handleBlockStop(index: number): void {
		if (blockTypes.get(index) !== "tool_use") return;
		const tc = toolCalls.get(index);
		if (!tc) return;
		let args: Record<string, unknown> = {};
		try {
			args = tc.argsJson ? JSON.parse(tc.argsJson) : {};
		} catch {
			log.warn(`Failed to parse tool call args for ${tc.name}`);
		}
		emitSSE("tool_call_args", JSON.stringify({ toolCallId: tc.id, toolName: tc.name, args }));
	}

	function processStreamEvent(event: Record<string, unknown>): void {
		const index = event.index as number;
		switch (event.type) {
			case "content_block_start": {
				const block = event.content_block as Record<string, unknown> | undefined;
				if (block) handleBlockStart(index, block);
				break;
			}
			case "content_block_delta": {
				const delta = event.delta as Record<string, unknown> | undefined;
				if (delta) handleBlockDelta(index, delta);
				break;
			}
			case "content_block_stop":
				handleBlockStop(index);
				break;
			case "message_start":
				emitUserToolResults(event, emitSSE);
				break;
		}
	}

	return {
		process(msg: Record<string, unknown>): void {
			if (msg.type === "user") {
				emitUserToolResults(msg, emitSSE);
				return;
			}
			if (msg.type !== "stream_event") return;
			const event = msg.event as Record<string, unknown> | undefined;
			if (event) processStreamEvent(event);
		},
	};
}

async function prepareInvocation(options: CliChatOptions): Promise<{
	invocationDir: string;
	args: string[];
	model: string;
}> {
	const invocationDir = createInvocationDir();
	const systemPromptPath = writeSystemPrompt(invocationDir, options.systemPrompt);
	const model = getCliModel(options.model ?? LLM_MODEL);
	const hasImages = options.images && options.images.length > 0;

	let cliImagePaths = options.images;
	if (hasImages) {
		cliImagePaths = await resizeImagesForCli(options.images ?? [], invocationDir);
	}

	// Build a map from original path → resized path so we can find new images
	const newImageSet = new Set(options.newImages ?? []);
	const cliNewImagePaths =
		hasImages && options.newImages?.length
			? (options.images ?? [])
					.map((orig, i) => (newImageSet.has(orig) ? cliImagePaths![i] : null))
					.filter((p): p is string => p !== null)
			: undefined;

	// MCP config gets ALL images so Claude can re-view if needed
	const mcpConfigPath = writeMcpConfig(invocationDir, cliImagePaths);
	// Prompt only instructs Claude to view NEW images
	const prompt =
		buildPrompt(options.messages, cliNewImagePaths) ||
		(cliNewImagePaths?.length ? "Describe this image." : "");
	const args = buildCliArgs(model, mcpConfigPath, systemPromptPath, BLOCKED_BUILTIN_TOOLS, prompt);

	return { invocationDir, args, model };
}

function spawnCli(args: string[], cwd: string): ChildProcessWithoutNullStreams {
	return spawn("claude", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			SHELL: process.env.SHELL,
			TERM: process.env.TERM,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function pipeStdout(
	proc: ChildProcessWithoutNullStreams,
	parser: ReturnType<typeof createStreamParser>,
	startMs: number,
): void {
	const lineBuffer = new LineBuffer();

	proc.stdout?.on("data", (chunk: Buffer) => {
		for (const line of lineBuffer.push(chunk.toString())) {
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
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

function wireProcessLifecycle(
	proc: ChildProcessWithoutNullStreams,
	emitSSE: SSEEmitter,
	parser: ReturnType<typeof createStreamParser>,
	startMs: number,
	invocationDir: string,
	signal?: AbortSignal,
): void {
	proc.stdin?.end();
	log.info(`cli-chat PID: ${proc.pid}`);

	if (signal) {
		signal.addEventListener("abort", () => {
			log.info(`cli-chat abort signal, killing PID ${proc.pid}`);
			proc.kill("SIGTERM");
		});
	}

	let closed = false;
	const finalize = (emitError?: string): void => {
		if (closed) return;
		closed = true;
		if (emitError) emitSSE("error", JSON.stringify({ error: emitError }));
		emitSSE("done", "[DONE]");
	};

	pipeStdout(proc, parser, startMs);

	proc.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) log.warn(`cli-chat stderr: ${text.slice(0, 300)}`);
	});

	proc.on("close", (code) => {
		const elapsed = (performance.now() - startMs).toFixed(0);
		log.info(`cli-chat process exited code=${code} elapsed=${elapsed}ms`);
		finalize();
		cleanupDir(invocationDir);
	});

	proc.on("error", (err) => {
		log.error(`cli-chat process error: ${err.message}`);
		finalize(err.message);
		cleanupDir(invocationDir);
	});
}

export function streamCliChat(options: CliChatOptions): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			const emitSSE: SSEEmitter = (event, data) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			};

			const { invocationDir, args, model } = await prepareInvocation(options);
			const startMs = performance.now();
			log.info(
				`cli-chat START — model=${model} mcp=${MCP_URL} prompt=${args[args.length - 1].length} chars`,
			);

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawnCli(args, invocationDir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Unknown spawn error";
				log.error(`cli-chat spawn failed: ${msg}`);
				emitSSE("error", JSON.stringify({ error: msg }));
				emitSSE("done", "[DONE]");
				controller.close();
				return;
			}

			let controllerClosed = false;
			const safeEmitSSE: SSEEmitter = (event, data) => {
				if (controllerClosed) return;
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			};

			const closeController = () => {
				if (controllerClosed) return;
				controllerClosed = true;
				controller.close();
			};

			const parser = createStreamParser(safeEmitSSE);

			proc.on("close", closeController);
			proc.on("error", closeController);

			wireProcessLifecycle(proc, safeEmitSSE, parser, startMs, invocationDir, options.signal);
		},
	});
}
