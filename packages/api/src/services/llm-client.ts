import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@cramkit/shared";

const log = createLogger("api");

export const LLM_MODEL = process.env.LLM_MODEL || "claude-opus-4-6";

export function getCliModel(model: string): string {
	if (model.includes("opus")) return "opus";
	if (model.includes("haiku")) return "haiku";
	return "sonnet";
}

interface PreparedMessages {
	systemParts: string[];
	prompt: string;
}

function prepareMessages(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): PreparedMessages {
	const clean = messages.map((m) => ({ ...m, content: m.content.replaceAll("\0", "") }));

	const systemParts = clean.filter((m) => m.role === "system").map((m) => m.content);
	const prompt = clean
		.filter((m) => m.role !== "system")
		.map((m) =>
			m.role === "assistant"
				? `<previous_response>\n${m.content}\n</previous_response>`
				: m.content,
		)
		.join("\n\n")
		.trim();

	if (!prompt) {
		throw new Error("No user prompt found in messages");
	}

	return { systemParts, prompt };
}

function writeSystemPrompt(tempDir: string, systemParts: string[], args: string[]): void {
	if (systemParts.length > 0) {
		const systemPromptPath = join(tempDir, "system-prompt.txt");
		writeFileSync(systemPromptPath, systemParts.join("\n\n"));
		args.push("--append-system-prompt-file", systemPromptPath);
	}
}

function spawnClaude(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const { PATH, HOME, SHELL, TERM } = process.env;
		const proc = spawn("claude", args, {
			cwd,
			env: { PATH, HOME, SHELL, TERM },
			stdio: ["pipe", "pipe", "pipe"],
		});

		proc.stdin?.end();

		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			if (code !== 0) {
				const output = (stderr || stdout).slice(0, 500);
				reject(new Error(`Claude CLI error (exit code ${code}): ${output}`));
				return;
			}
			resolve({ stdout, stderr });
		});

		proc.on("error", (err) => {
			reject(new Error(`Claude CLI spawn error: ${err.message}`));
		});
	});
}

export async function chatCompletion(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	options?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<string> {
	const model = getCliModel(options?.model || LLM_MODEL);
	log.info(`chatCompletion — model=${model}, messages=${messages.length}`);

	const { systemParts, prompt } = prepareMessages(messages);

	const tempDir = join(tmpdir(), `cramkit-llm-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	const args = [
		"--print",
		"--output-format",
		"text",
		"--model",
		model,
		"--dangerously-skip-permissions",
		"--setting-sources",
		"",
		"--no-session-persistence",
	];

	writeSystemPrompt(tempDir, systemParts, args);
	args.push(prompt);

	const { stdout } = await spawnClaude(args, tempDir);
	const content = stdout.trim();

	if (!content) {
		throw new Error("LLM returned empty response");
	}

	log.info(`chatCompletion — response ${content.length} chars`);
	return content;
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const BLOCKED_BUILTIN_TOOLS = [
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

export async function chatCompletionWithTool<T>(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	tool: ToolDefinition,
	options?: { model?: string; maxTokens?: number },
): Promise<T> {
	const model = getCliModel(options?.model || LLM_MODEL);
	log.info(
		`chatCompletionWithTool — model=${model}, tool=${tool.name}, messages=${messages.length}`,
	);

	const { systemParts, prompt } = prepareMessages(messages);

	const tempDir = join(tmpdir(), `cramkit-tool-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	const toolSchemaPath = join(tempDir, "tool-schema.json");
	writeFileSync(toolSchemaPath, JSON.stringify(tool));

	const resultPath = join(tempDir, "result.json");
	const mcpScript = `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");

const toolDef = JSON.parse(fs.readFileSync(${JSON.stringify(toolSchemaPath)}, "utf-8"));
const resultPath = ${JSON.stringify(resultPath)};

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
        serverInfo: { name: "extractor", version: "1.0.0" },
      }});
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: [{
        name: toolDef.name,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
      }]}});
      break;
    case "tools/call": {
      const args = req.params?.arguments || {};
      fs.writeFileSync(resultPath, JSON.stringify(args, null, 2));
      send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: "Submitted successfully." }],
      }});
      break;
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;
	const mcpScriptPath = join(tempDir, "extractor-mcp.js");
	writeFileSync(mcpScriptPath, mcpScript);

	const mcpConfig = {
		mcpServers: {
			extractor: {
				type: "stdio",
				command: "node",
				args: [mcpScriptPath],
			},
		},
	};
	const mcpConfigPath = join(tempDir, "mcp-config.json");
	writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

	const args = [
		"--print",
		"--output-format",
		"text",
		"--model",
		model,
		"--mcp-config",
		mcpConfigPath,
		"--strict-mcp-config",
		"--dangerously-skip-permissions",
		"--max-turns",
		"2",
		"--disallowedTools",
		...BLOCKED_BUILTIN_TOOLS,
		"--setting-sources",
		"",
		"--no-session-persistence",
	];

	writeSystemPrompt(tempDir, systemParts, args);
	args.push(prompt);

	try {
		await spawnClaude(args, tempDir);

		if (!existsSync(resultPath)) {
			throw new Error("Model did not call the extraction tool — no result.json produced");
		}

		const raw = readFileSync(resultPath, "utf-8");
		const parsed = JSON.parse(raw) as T;
		log.info(`chatCompletionWithTool — got result (${raw.length} chars)`);
		return parsed;
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}
