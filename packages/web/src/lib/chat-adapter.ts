import type { AttachmentAdapter, ChatModelAdapter, ChatModelRunResult } from "@assistant-ui/react";

const BASE_URL = "/api";

export const chatAttachmentAdapter: AttachmentAdapter = {
	accept: "image/jpeg,image/png,image/gif,image/webp",

	async add({ file }) {
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

type ContentPart =
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
	| { type: "text"; text: string };

interface SseState {
	textContent: string;
	thinkingText: string;
	toolCalls: Map<string, ToolCallState>;
}

function parseTextToolCalls(text: string) {
	const callRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
	const resultRegex = /<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g;

	const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
	const results: string[] = [];

	let m: RegExpExecArray | null;
	m = callRegex.exec(text);
	while (m !== null) {
		try {
			const parsed = JSON.parse(m[1]);
			calls.push({
				toolName: parsed.name || "unknown",
				args: parsed.arguments || {},
			});
		} catch {
			// Skip unparseable
		}
		m = callRegex.exec(text);
	}

	m = resultRegex.exec(text);
	while (m !== null) {
		results.push(m[1].trim());
		m = resultRegex.exec(text);
	}

	const parsedCalls = calls.map((call, i) => ({
		id: `text_tc_${i}`,
		toolName: call.toolName,
		args: call.args,
		result: results[i],
	}));

	const cleanText = text
		.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
		.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
		.replace(/<tool_call[\s\S]*$/, "")
		.replace(/<tool_result[\s\S]*$/, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return { cleanText, parsedCalls };
}

function buildContentParts(state: SseState): ContentPart[] {
	const parts: ContentPart[] = [];

	if (state.thinkingText) {
		parts.push({ type: "reasoning", text: state.thinkingText });
	}

	for (const tc of state.toolCalls.values()) {
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

	const { cleanText, parsedCalls } = parseTextToolCalls(state.textContent);
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

	parts.push({ type: "text", text: cleanText });

	return parts;
}

// biome-ignore lint/suspicious/noExplicitAny: assistant-ui message types are loosely typed
function extractAttachmentIds(message: any): string[] {
	if (!message?.attachments || !Array.isArray(message.attachments)) return [];
	return (
		message.attachments
			.filter(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic attachment shape
				(att: any) => typeof att?.id === "string" && att.id,
			)
			// biome-ignore lint/suspicious/noExplicitAny: dynamic attachment shape
			.map((att: any) => att.id as string)
	);
}

const CUID_PATTERN = /^c[a-z0-9]{20,}$/;

// biome-ignore lint/suspicious/noExplicitAny: assistant-ui message types are loosely typed
function extractRewindId(message: any): string | undefined {
	if (!message?.id) return undefined;
	const msgId = message.id as string;
	return CUID_PATTERN.test(msgId) ? msgId : undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: assistant-ui message types are loosely typed
function extractUserText(message: any): string {
	return (
		message?.content
			.filter((part: { type: string }) => part.type === "text")
			.map((part: { text: string }) => part.text)
			.join("") || ""
	);
}

function handleSseEvent(
	eventType: string,
	// biome-ignore lint/suspicious/noExplicitAny: SSE event data is dynamically typed
	parsed: any,
	state: SseState,
): boolean {
	switch (eventType) {
		case "content":
			if (parsed.content) {
				state.textContent += parsed.content;
				return true;
			}
			return false;

		case "tool_call_start":
			state.toolCalls.set(parsed.toolCallId, {
				toolCallId: parsed.toolCallId,
				toolName: parsed.toolName,
			});
			return true;

		case "tool_call_args": {
			const tc = state.toolCalls.get(parsed.toolCallId);
			if (tc) tc.args = parsed.args;
			return true;
		}

		case "tool_result": {
			const tc = state.toolCalls.get(parsed.toolCallId);
			if (tc) {
				tc.result = parsed.result;
				tc.isError = parsed.isError;
			}
			return true;
		}

		case "thinking_delta":
			if (parsed.text) {
				state.thinkingText += parsed.text;
				return true;
			}
			return false;

		default:
			return false;
	}
}

async function* readSseStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: SseState,
): AsyncGenerator<ChatModelRunResult> {
	const decoder = new TextDecoder();
	let buffer = "";
	let currentEventType = "content";
	const yieldContent = () => ({ content: buildContentParts(state) }) as ChatModelRunResult;

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

				if (trimmed.startsWith("event: ")) {
					currentEventType = trimmed.slice(7);
					continue;
				}

				if (trimmed.startsWith("data: ")) {
					const data = trimmed.slice(6);
					if (data === "[DONE]") {
						yield yieldContent();
						return;
					}

					try {
						const parsed = JSON.parse(data);
						if (handleSseEvent(currentEventType, parsed, state)) {
							yield yieldContent();
						}
					} catch {
						// Skip unparseable
					}

					currentEventType = "content";
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (state.textContent || state.toolCalls.size > 0 || state.thinkingText) {
		yield yieldContent();
	}
}

export function createCramKitChatAdapter(
	sessionId: string,
	conversationId: string,
): ChatModelAdapter {
	return {
		async *run({ messages, abortSignal }) {
			const lastMessage = messages[messages.length - 1];
			const userText = extractUserText(lastMessage);
			const attachmentIds = extractAttachmentIds(lastMessage);
			const rewindToMessageId = extractRewindId(lastMessage);

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
					status: { type: "incomplete", reason: "error", error: errorText },
				} as ChatModelRunResult;
				return;
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body");

			const state: SseState = {
				textContent: "",
				thinkingText: "",
				toolCalls: new Map<string, ToolCallState>(),
			};

			yield* readSseStream(reader, state);
		},
	};
}
