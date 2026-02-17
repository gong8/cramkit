import type { AttachmentAdapter, ChatModelAdapter } from "@assistant-ui/react";

const BASE_URL = "/api";

export const chatAttachmentAdapter: AttachmentAdapter = {
	accept: "image/jpeg,image/png,image/gif,image/webp",

	async add({ file }) {
		const formData = new FormData();
		formData.append("file", file);
		const res = await fetch(`${BASE_URL}/chat/attachments`, {
			method: "POST",
			body: formData,
		});
		if (!res.ok) {
			throw new Error(`Upload failed: ${res.status}`);
		}
		const { id, filename, contentType } = (await res.json()) as {
			id: string;
			url: string;
			filename: string;
			contentType: string;
		};
		return {
			id,
			type: "image" as const,
			name: filename,
			contentType,
			file,
			status: { type: "requires-action" as const, reason: "composer-send" as const },
		};
	},

	async send(attachment) {
		return {
			...attachment,
			status: { type: "complete" as const },
			content: [
				{
					type: "image" as const,
					image: `${BASE_URL}/chat/attachments/${attachment.id}`,
				},
			],
		};
	},

	async remove(attachment) {
		await fetch(`${BASE_URL}/chat/attachments/${attachment.id}`, {
			method: "DELETE",
		}).catch(() => {});
	},
};

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

			// Extract attachment IDs from image parts
			const attachmentIds = lastMessage?.content
				.filter((part): part is { type: "image"; image: string } => part.type === "image")
				.map((part) => {
					// URL format: /api/chat/attachments/{id}
					const match = part.image.match(/\/attachments\/([^/]+)$/);
					return match?.[1];
				})
				.filter((id): id is string => !!id);

			const response = await fetch(`${BASE_URL}/chat/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId,
					conversationId,
					message: userText,
					attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
				}),
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
