import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@cramkit/shared";

const log = createLogger("api");

const LLM_MODEL = process.env.LLM_MODEL || "claude-opus-4-6";

function getCliModel(model: string): string {
	if (model.includes("opus")) return "opus";
	if (model.includes("haiku")) return "haiku";
	return "sonnet";
}

export async function chatCompletion(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	options?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<string> {
	const model = getCliModel(options?.model || LLM_MODEL);
	log.info(`chatCompletion — model=${model}, messages=${messages.length}`);

	// Strip null bytes from message content — PDF extraction can leave them in
	const sanitizedMessages = messages.map((m) => ({
		...m,
		content: m.content.replaceAll("\0", ""),
	}));

	// Build the prompt: system messages go to --append-system-prompt, rest inline
	const systemParts: string[] = [];
	const promptParts: string[] = [];

	for (const msg of sanitizedMessages) {
		if (msg.role === "system") {
			systemParts.push(msg.content);
		} else if (msg.role === "assistant") {
			promptParts.push(`<previous_response>\n${msg.content}\n</previous_response>`);
		} else {
			promptParts.push(msg.content);
		}
	}

	const prompt = promptParts.join("\n\n").trim();
	if (!prompt) {
		throw new Error("No user prompt found in messages");
	}

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

	if (options?.maxTokens) {
		args.push("--max-tokens", String(options.maxTokens));
	}

	if (systemParts.length > 0) {
		const systemPromptPath = join(tempDir, "system-prompt.txt");
		writeFileSync(systemPromptPath, systemParts.join("\n\n"));
		args.push("--append-system-prompt-file", systemPromptPath);
	}

	args.push(prompt);

	return new Promise<string>((resolve, reject) => {
		const proc = spawn("claude", args, {
			cwd: tempDir,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				SHELL: process.env.SHELL,
				TERM: process.env.TERM,
			},
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
				log.error(`chatCompletion — CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
				reject(new Error(`Claude CLI error (exit code ${code}): ${stderr.slice(0, 500)}`));
				return;
			}

			const content = stdout.trim();
			if (!content) {
				reject(new Error("LLM returned empty response"));
				return;
			}

			log.info(`chatCompletion — response ${content.length} chars`);
			resolve(content);
		});

		proc.on("error", (err) => {
			log.error(`chatCompletion — spawn error: ${err.message}`);
			reject(new Error(`Claude CLI spawn error: ${err.message}`));
		});
	});
}
