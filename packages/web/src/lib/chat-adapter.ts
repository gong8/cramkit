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

			// Extract attachment IDs from image parts in content
			const contentImageIds =
				lastMessage?.content
					.filter((part): part is { type: "image"; image: string } => part.type === "image")
					.map((part) => {
						// URL format: /api/chat/attachments/{id}
						const match = part.image.match(/\/attachments\/([^/]+)$/);
						return match?.[1];
					})
					.filter((id): id is string => !!id) ?? [];

			// Also check the attachments property (assistant-ui may not merge into content)
			const msgAttachments = (lastMessage as Record<string, unknown>)?.attachments as
				| Array<{ id: string }>
				| undefined;
			const attachmentPropIds = msgAttachments?.map((a) => a.id).filter(Boolean) ?? [];

			const attachmentIds = [...new Set([...contentImageIds, ...attachmentPropIds])];

			// Detect retry: check if the last user message has an existing ID (from history)
			const lastUserMsg = lastMessage;
			let rewindToMessageId: string | undefined;
			if (lastUserMsg && "id" in lastUserMsg && lastUserMsg.id) {
				// Only treat as rewind if the ID is a real DB ID (Prisma cuid format),
				// not an auto-generated short ID from assistant-ui
				const msgId = lastUserMsg.id as string;
				if (/^c[a-z0-9]{20,}$/.test(msgId)) {
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
					attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
					rewindToMessageId,
				}),
				signal: abortSignal,
			});

			if (!response.ok) {
				const errorText =
					response.status === 404
						? "This conversation no longer exists. Please start a new one."
						: `Something went wrong (${response.status}). Please try again.`;
				yield {
					content: [{ type: "text", text: errorText }],
					status: {
						type: "incomplete",
						reason: "error",
						error: errorText,
					},
				} as ChatModelRunResult;
				return;
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body");

			const decoder = new TextDecoder();
			let buffer = "";
			let textContent = "";
			let thinkingText = "";
			const toolCalls = new Map<string, ToolCallState>();

			/**
			 * Parse <tool_call> and <tool_result> XML from text content into
			 * structured tool-call parts that assistant-ui renders via ToolCallDisplay.
			 */
			function parseTextToolCalls(text: string) {
				const callRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
				const resultRegex = /<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g;

				const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
				const results: string[] = [];

				let m: RegExpExecArray | null;
				while ((m = callRegex.exec(text)) !== null) {
					try {
						const parsed = JSON.parse(m[1]);
						calls.push({
							toolName: parsed.name || "unknown",
							args: parsed.arguments || {},
						});
					} catch {
						// Skip unparseable
					}
				}

				while ((m = resultRegex.exec(text)) !== null) {
					results.push(m[1].trim());
				}

				const parsedCalls = calls.map((call, i) => ({
					id: `text_tc_${i}`,
					toolName: call.toolName,
					args: call.args,
					result: results[i],
				}));

				// Strip complete tags and trailing incomplete tags
				const cleanText = text
					.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
					.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
					.replace(/<tool_call[\s\S]*$/, "")
					.replace(/<tool_result[\s\S]*$/, "")
					.replace(/\n{3,}/g, "\n\n")
					.trim();

				return { cleanText, parsedCalls };
			}

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

				// SSE-based tool calls (from proper tool_use content blocks)
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

				// Parse text-embedded tool calls (from <tool_call> XML in text)
				const { cleanText, parsedCalls } = parseTextToolCalls(textContent);
				for (const pc of parsedCalls) {
					parts.push({
						type: "tool-call",
						toolCallId: pc.id,
						toolName: pc.toolName,
						args: pc.args,
						argsText: JSON.stringify(pc.args),
						result: pc.result,
						isError: false,
					});
				}

				// Clean text content (XML stripped)
				parts.push({ type: "text", text: cleanText });

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
