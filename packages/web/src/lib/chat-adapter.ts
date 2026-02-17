import type { ChatModelAdapter } from "@assistant-ui/react";

const BASE_URL = "/api";

export function createCramKitChatAdapter(
	sessionId: string,
	conversationId: string,
): ChatModelAdapter {
	return {
		async *run({ messages, abortSignal }) {
			// Extract the latest user message
			const lastMessage = messages[messages.length - 1];
			const userText =
				lastMessage?.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("") || "";

			const response = await fetch(`${BASE_URL}/chat/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, conversationId, message: userText }),
				signal: abortSignal,
			});

			if (!response.ok) {
				throw new Error(`Chat API error: ${response.status}`);
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body");

			const decoder = new TextDecoder();
			let buffer = "";
			let fullContent = "";

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

						if (trimmed.startsWith("data: ")) {
							const data = trimmed.slice(6);
							if (data === "[DONE]") {
								yield {
									content: [{ type: "text" as const, text: fullContent }],
								};
								return;
							}

							try {
								const parsed = JSON.parse(data) as { content?: string };
								if (parsed.content) {
									fullContent += parsed.content;
									yield {
										content: [{ type: "text" as const, text: fullContent }],
									};
								}
							} catch {
								// Skip unparseable
							}
						}
					}
				}
			} finally {
				reader.releaseLock();
			}

			if (fullContent) {
				yield {
					content: [{ type: "text" as const, text: fullContent }],
				};
			}
		},
	};
}
