import { createLogger } from "@cramkit/shared";

const log = createLogger("api");

const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:3456/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || "proxy-mode-no-key-required";
const LLM_MODEL = process.env.LLM_MODEL || "claude-opus-4-6";

export async function chatCompletion(
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	options?: { model?: string; temperature?: number; maxTokens?: number },
): Promise<string> {
	const model = options?.model || LLM_MODEL;
	const temperature = options?.temperature ?? 0;
	const maxTokens = options?.maxTokens ?? 4096;

	log.info(`chatCompletion — model=${model}, messages=${messages.length}, temperature=${temperature}`);

	// Strip null bytes from message content — PDF extraction can leave them in
	const sanitizedMessages = messages.map((m) => ({
		...m,
		content: m.content.replaceAll("\0", ""),
	}));

	const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${LLM_API_KEY}`,
		},
		body: JSON.stringify({
			model,
			messages: sanitizedMessages,
			temperature,
			max_tokens: maxTokens,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		log.error(`chatCompletion — ${response.status}: ${errorText}`);
		throw new Error(`LLM API error ${response.status}: ${errorText}`);
	}

	const data = (await response.json()) as {
		choices: Array<{ message: { content: string } }>;
	};

	const content = data.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error("LLM returned empty response");
	}

	log.info(`chatCompletion — response ${content.length} chars`);
	return content;
}
