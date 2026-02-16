import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the actual module, mocking global.fetch
const originalFetch = global.fetch;

beforeEach(() => {
	vi.resetModules();
	global.fetch = vi.fn();
});

afterEach(() => {
	global.fetch = originalFetch;
});

function mockFetchResponse(body: unknown, status = 200) {
	(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body)),
	});
}

async function loadChatCompletion() {
	const mod = await import("../../packages/api/src/services/llm-client.js");
	return mod.chatCompletion;
}

describe("chatCompletion", () => {
	it("sends correct request shape", async () => {
		mockFetchResponse({
			choices: [{ message: { content: "Hello" } }],
		});

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "Hi" }]);

		expect(global.fetch).toHaveBeenCalledOnce();
		const [url, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

		expect(url).toBe("http://localhost:3456/v1/chat/completions");
		expect(options.method).toBe("POST");
		expect(options.headers["Content-Type"]).toBe("application/json");
		expect(options.headers.Authorization).toMatch(/^Bearer /);

		const body = JSON.parse(options.body);
		expect(body).toHaveProperty("model");
		expect(body).toHaveProperty("messages");
		expect(body).toHaveProperty("temperature");
		expect(body).toHaveProperty("max_tokens");
		expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
	});

	it("returns assistant content string", async () => {
		mockFetchResponse({
			choices: [{ message: { content: "The answer is 42" } }],
		});

		const chatCompletion = await loadChatCompletion();
		const result = await chatCompletion([{ role: "user", content: "question" }]);

		expect(result).toBe("The answer is 42");
	});

	it("uses env defaults", async () => {
		mockFetchResponse({
			choices: [{ message: { content: "ok" } }],
		});

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "test" }]);

		const [url, options] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		const body = JSON.parse(options.body);

		expect(url).toContain("localhost:3456");
		expect(body.model).toBe("claude-opus-4-6");
		expect(body.temperature).toBe(0);
		expect(body.max_tokens).toBe(4096);
	});

	it("respects option overrides", async () => {
		mockFetchResponse({
			choices: [{ message: { content: "ok" } }],
		});

		const chatCompletion = await loadChatCompletion();
		await chatCompletion([{ role: "user", content: "test" }], {
			model: "custom-model",
			temperature: 0.7,
			maxTokens: 2048,
		});

		const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);

		expect(body.model).toBe("custom-model");
		expect(body.temperature).toBe(0.7);
		expect(body.max_tokens).toBe(2048);
	});

	it("throws on HTTP error", async () => {
		mockFetchResponse("Internal Server Error", 500);

		const chatCompletion = await loadChatCompletion();

		await expect(
			chatCompletion([{ role: "user", content: "test" }]),
		).rejects.toThrow(/LLM API error 500/);
	});

	it("throws on empty response", async () => {
		mockFetchResponse({ choices: [] });

		const chatCompletion = await loadChatCompletion();

		await expect(
			chatCompletion([{ role: "user", content: "test" }]),
		).rejects.toThrow("LLM returned empty response");
	});
});
