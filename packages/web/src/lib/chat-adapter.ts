import type { AttachmentAdapter, ChatModelAdapter, ChatModelRunResult } from "@assistant-ui/react";

const BASE_URL = "/api";

export const chatAttachmentAdapter: AttachmentAdapter = {
	accept: "image/jpeg,image/png,image/gif,image/webp",

	async add({ file }) {
		// Restore a draft attachment without re-uploading
		const restoreMatch = file.name.match(/^__restore__([^_]+)__(.+)$/);
		if (restoreMatch) {
			const [, id, originalName] = restoreMatch;
			return {
				id,
				type: "image" as const,
				name: originalName,
				contentType: file.type,
				file,
				status: { type: "requires-action" as const, reason: "composer-send" as const },
			};
		}

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

interface ToolCallState {
	toolCallId: string;
	toolName: string;
	args?: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

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

			// Detect retry: check if the last user message has an existing ID (from history)
			const lastUserMsg = lastMessage;
			let rewindToMessageId: string | undefined;
			if (lastUserMsg && "id" in lastUserMsg && lastUserMsg.id) {
				// This is a retry/edit — the message already exists in history
				// Check if it's a real DB ID (not a generated one)
				const msgId = lastUserMsg.id as string;
				if (!msgId.startsWith("__")) {
					rewindToMessageId = msgId;
				}
			}

			const response = await fetch(`${BASE_URL}/chat/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId,
					conversationId,
					message: userText,
					attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
					rewindToMessageId,
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
			let textContent = "";
			let thinkingText = "";
			const toolCalls = new Map<string, ToolCallState>();

			function buildContentParts() {
				const parts: Array<
					| { type: "reasoning"; text: string }
					| {
							type: "tool-call";
							toolCallId: string;
							toolName: string;
							args: Record<string, unknown>;
							argsText: string;
							result?: unknown;
							isError?: boolean;
					  }
					| { type: "text"; text: string }
				> = [];

				// Thinking/reasoning block
				if (thinkingText) {
					parts.push({ type: "reasoning", text: thinkingText });
				}

				// Tool calls
				for (const tc of toolCalls.values()) {
					parts.push({
						type: "tool-call",
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						args: tc.args ?? {},
						argsText: JSON.stringify(tc.args ?? {}),
						result: tc.result,
						isError: tc.isError,
					});
				}

				// Text content
				parts.push({ type: "text", text: textContent });

				return parts;
			}

			try {
				let currentEventType = "content";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

						// Parse SSE event type
						if (trimmed.startsWith("event: ")) {
							currentEventType = trimmed.slice(7);
							continue;
						}

						if (trimmed.startsWith("data: ")) {
							const data = trimmed.slice(6);
							if (data === "[DONE]") {
								yield { content: buildContentParts() } as ChatModelRunResult;
								return;
							}

							try {
								const parsed = JSON.parse(data);

								switch (currentEventType) {
									case "content": {
										if (parsed.content) {
											textContent += parsed.content;
											yield { content: buildContentParts() } as ChatModelRunResult;
										}
										break;
									}

									case "tool_call_start": {
										const { toolCallId, toolName } = parsed;
										toolCalls.set(toolCallId, {
											toolCallId,
											toolName,
										});
										yield { content: buildContentParts() } as ChatModelRunResult;
										break;
									}

									case "tool_call_args": {
										const { toolCallId, args } = parsed;
										const tc = toolCalls.get(toolCallId);
										if (tc) {
											tc.args = args;
										}
										yield { content: buildContentParts() } as ChatModelRunResult;
										break;
									}

									case "tool_result": {
										const { toolCallId, result, isError } = parsed;
										const tc = toolCalls.get(toolCallId);
										if (tc) {
											tc.result = result;
											tc.isError = isError;
										}
										yield { content: buildContentParts() } as ChatModelRunResult;
										break;
									}

									case "thinking_delta": {
										if (parsed.text) {
											thinkingText += parsed.text;
											yield { content: buildContentParts() } as ChatModelRunResult;
										}
										break;
									}

									case "thinking_start": {
										// Just mark that thinking has started, text comes via deltas
										break;
									}
								}
							} catch {
								// Skip unparseable
							}

							// Reset event type after data line
							currentEventType = "content";
						}
					}
				}
			} finally {
				reader.releaseLock();
			}

			if (textContent || toolCalls.size > 0 || thinkingText) {
				yield { content: buildContentParts() } as ChatModelRunResult;
			}
		},
	};
}
