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
	const calls = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].flatMap((m) => {
		try {
			const parsed = JSON.parse(m[1]);
			return [{ toolName: parsed.name || "unknown", args: parsed.arguments || {} }];
		} catch {
			return [];
		}
	});

	const results = [...text.matchAll(/<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g)].map((m) =>
		m[1].trim(),
	);

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

function toToolCallPart(
	id: string,
	name: string,
	args: Record<string, unknown>,
	result?: string,
	isError?: boolean,
): ContentPart {
	return {
		type: "tool-call",
		toolCallId: id,
		toolName: name,
		args,
		argsText: JSON.stringify(args),
		result,
		isError,
	};
}

function buildContentParts(state: SseState): ContentPart[] {
	const { cleanText, parsedCalls } = parseTextToolCalls(state.textContent);

	return [
		...(state.thinkingText ? [{ type: "reasoning" as const, text: state.thinkingText }] : []),
		...[...state.toolCalls.values()].map((tc) =>
			toToolCallPart(tc.toolCallId, tc.toolName, tc.args ?? {}, tc.result, tc.isError),
		),
		...parsedCalls.map((pc) => toToolCallPart(pc.id, pc.toolName, pc.args, pc.result, false)),
		{ type: "text" as const, text: cleanText },
	];
}

function extractAttachmentIds(message: unknown): string[] {
	const msg = message as Record<string, unknown> | null | undefined;
	if (!msg?.attachments || !Array.isArray(msg.attachments)) return [];
	return msg.attachments
		.filter((att: unknown) => {
			const a = att as Record<string, unknown> | null | undefined;
			return typeof a?.id === "string" && a.id;
		})
		.map((att: unknown) => (att as Record<string, unknown>).id as string);
}

const CUID_PATTERN = /^c[a-z0-9]{20,}$/;

function extractRewindId(message: unknown): string | undefined {
	const msg = message as Record<string, unknown> | null | undefined;
	if (!msg?.id) return undefined;
	const msgId = msg.id as string;
	return CUID_PATTERN.test(msgId) ? msgId : undefined;
}

function extractUserText(message: unknown): string {
	const msg = message as Record<string, unknown> | null | undefined;
	if (!msg?.content || !Array.isArray(msg.content)) return "";
	return (
		msg.content
			.filter((part: { type: string }) => part.type === "text")
			.map((part: { text: string }) => part.text)
			.join("") || ""
	);
}

function handleSseEvent(
	eventType: string,
	parsed: Record<string, unknown>,
	state: SseState,
): boolean {
	switch (eventType) {
		case "content":
			if (parsed.content) {
				state.textContent += parsed.content as string;
				return true;
			}
			return false;

		case "tool_call_start":
			state.toolCalls.set(parsed.toolCallId as string, {
				toolCallId: parsed.toolCallId as string,
				toolName: parsed.toolName as string,
			});
			return true;

		case "tool_call_args": {
			const tc = state.toolCalls.get(parsed.toolCallId as string);
			if (tc) tc.args = parsed.args as Record<string, unknown>;
			return true;
		}

		case "tool_result": {
			const tc = state.toolCalls.get(parsed.toolCallId as string);
			if (tc) {
				tc.result = parsed.result as string;
				tc.isError = parsed.isError as boolean;
			}
			return true;
		}

		case "thinking_delta":
			if (parsed.text) {
				state.thinkingText += parsed.text as string;
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
	let eventType = "content";
	const snapshot = () => ({ content: buildContentParts(state) }) as ChatModelRunResult;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const raw of lines) {
				const line = raw.trim();
				if (!line) continue;

				if (line.startsWith("event: ")) {
					eventType = line.slice(7);
				} else if (line.startsWith("data: ")) {
					const data = line.slice(6);
					if (data === "[DONE]") {
						yield snapshot();
						return;
					}
					try {
						if (handleSseEvent(eventType, JSON.parse(data), state)) yield snapshot();
					} catch {}
					eventType = "content";
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (state.textContent || state.toolCalls.size > 0 || state.thinkingText) {
		yield snapshot();
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

			// The messages array has all prior messages + the new/edited user message at
			// the end. messages.length - 1 = how many messages should exist in the DB
			// before this new one. The backend uses this to trim orphaned messages when
			// the user edits a message mid-conversation (assistant-ui generates nanoid
			// IDs for edited messages, so rewindToMessageId won't be set).
			const expectedPriorCount = rewindToMessageId ? undefined : messages.length - 1;

			const response = await fetch(`${BASE_URL}/chat/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId,
					conversationId,
					message: userText,
					attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
					rewindToMessageId,
					expectedPriorCount,
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
