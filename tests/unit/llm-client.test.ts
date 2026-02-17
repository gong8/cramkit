import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock("child_process", () => ({
	spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs and os
vi.mock("fs", () => ({
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("os", () => ({
	tmpdir: () => "/tmp",
}));

vi.mock("crypto", () => ({
	randomUUID: () => "test-uuid-1234",
}));

function setupMockProcess(stdout: string, exitCode = 0) {
	mockSpawn.mockImplementation(() => {
		const proc = new EventEmitter() as EventEmitter & {
			stdin: { end: ReturnType<typeof vi.fn> };
			stdout: EventEmitter;
			stderr: EventEmitter;
			pid: number;
			kill: ReturnType<typeof vi.fn>;
		};
		proc.stdin = { end: vi.fn() };
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.pid = 12345;
		proc.kill = vi.fn();

		// Schedule events after listeners are attached
		process.nextTick(() => {
			if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
			proc.emit("close", exitCode);
		});

		return proc;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

async function loadChatCompletion() {
	const mod = await import("../../packages/api/src/services/llm-client.js");
	return mod.chatCompletion;
}

describe("chatCompletion", () => {
	it("returns CLI stdout as response", async () => {
		setupMockProcess("The answer is 42");

		const chatCompletion = await loadChatCompletion();
		const result = await chatCompletion([{ role: "user", content: "question" }]);

		expect(result).toBe("The answer is 42");
	});

	it("passes correct CLI args", async () => {
		setupMockProcess("ok");

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "test" }]);

		expect(mockSpawn).toHaveBeenCalledOnce();
		const [cmd, args] = mockSpawn.mock.calls[0];

		expect(cmd).toBe("claude");
		expect(args).toContain("--print");
		expect(args).toContain("--output-format");
		expect(args).toContain("text");
		expect(args).toContain("--dangerously-skip-permissions");
		expect(args).toContain("--setting-sources");
		expect(args).toContain("--no-session-persistence");
		expect(args).toContain("test");
	});

	it("uses minimal env vars", async () => {
		setupMockProcess("ok");

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "test" }]);

		const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, unknown> };
		const envKeys = Object.keys(spawnOptions.env);

		expect(envKeys).toContain("PATH");
		expect(envKeys).toContain("HOME");
		expect(envKeys).not.toContain("LLM_BASE_URL");
		expect(envKeys).not.toContain("LLM_API_KEY");
	});

	it("respects model option overrides", async () => {
		setupMockProcess("ok");

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "test" }], {
			model: "claude-haiku-latest",
			maxTokens: 2048,
		});

		const args = mockSpawn.mock.calls[0][1] as string[];
		const modelIdx = args.indexOf("--model");
		expect(args[modelIdx + 1]).toBe("haiku");
		const maxIdx = args.indexOf("--max-tokens");
		expect(args[maxIdx + 1]).toBe("2048");
	});

	it("throws on non-zero exit code", async () => {
		setupMockProcess("", 1);

		const chatCompletion = await loadChatCompletion();

		await expect(
			chatCompletion([{ role: "user", content: "test" }]),
		).rejects.toThrow(/Claude CLI error/);
	});

	it("throws on empty response", async () => {
		setupMockProcess("");

		const chatCompletion = await loadChatCompletion();

		await expect(
			chatCompletion([{ role: "user", content: "test" }]),
		).rejects.toThrow("LLM returned empty response");
	});

	it("handles system messages via append-system-prompt-file", async () => {
		setupMockProcess("ok");

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([
			{ role: "system", content: "You are helpful" },
			{ role: "user", content: "Hi" },
		]);

		const args = mockSpawn.mock.calls[0][1] as string[];
		expect(args).toContain("--append-system-prompt-file");
		// The user prompt should be the last argument
		expect(args[args.length - 1]).toBe("Hi");
	});

	it("strips null bytes from content", async () => {
		setupMockProcess("ok");

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "test\0value" }]);

		const args = mockSpawn.mock.calls[0][1] as string[];
		expect(args[args.length - 1]).toBe("testvalue");
	});
});
