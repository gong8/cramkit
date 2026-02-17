import type { PrismaClient } from "@cramkit/shared";
import { createLogger } from "@cramkit/shared";
import type { ToolCallData } from "./cli-chat.js";

const log = createLogger("api");

/** A single SSE event to buffer for reconnection */
interface BufferedEvent {
	event: string;
	data: string;
}

type Subscriber = (event: string, data: string) => void;

export interface ActiveStream {
	conversationId: string;
	events: BufferedEvent[];
	status: "streaming" | "complete" | "error";
	fullContent: string;
	toolCallsData: ToolCallData[];
	subscribers: Set<Subscriber>;
	done: Promise<void>;
}

/** Strip leaked <tool_call>/<tool_result> XML from text content */
function stripToolCallXml(text: string): string {
	return text
		.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
		.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const CLEANUP_DELAY_MS = 60_000;

const activeStreams = new Map<string, ActiveStream>();

/** Persist the assistant message and update the conversation timestamp */
async function persistMessage(
	db: PrismaClient,
	conversationId: string,
	content: string,
	toolCallsData: ToolCallData[],
): Promise<void> {
	await db.message.create({
		data: {
			conversationId,
			role: "assistant",
			content: stripToolCallXml(content),
			toolCalls: toolCallsData.length > 0 ? JSON.stringify(toolCallsData) : null,
		},
	});
	await db.conversation.update({
		where: { id: conversationId },
		data: { updatedAt: new Date() },
	});
}

/** Safely persist, swallowing errors (e.g. if the conversation was deleted) */
async function safePersist(
	db: PrismaClient,
	conversationId: string,
	stream: ActiveStream,
): Promise<void> {
	if (!stream.fullContent && stream.toolCallsData.length === 0) return;
	try {
		await persistMessage(db, conversationId, stream.fullContent, stream.toolCallsData);
	} catch (e) {
		log.warn(
			`Failed to persist assistant message — conversation ${conversationId} may have been deleted`,
			e,
		);
	}
}

/** Dispatch a parsed SSE data payload, updating stream state and re-emitting */
function dispatchEvent(
	stream: ActiveStream,
	toolCallIndex: Map<string, number>,
	emit: (event: string, data: string) => void,
	eventType: string,
	parsed: Record<string, unknown>,
): void {
	switch (eventType) {
		case "content": {
			if (parsed.content) {
				stream.fullContent += parsed.content;
				emit("content", JSON.stringify({ content: parsed.content }));
			}
			break;
		}

		case "tool_call_start": {
			const { toolCallId, toolName } = parsed as { toolCallId: string; toolName: string };
			const idx = stream.toolCallsData.length;
			stream.toolCallsData.push({ toolCallId, toolName, args: {} });
			toolCallIndex.set(toolCallId, idx);
			emit("tool_call_start", JSON.stringify({ toolCallId, toolName }));
			break;
		}

		case "tool_call_args": {
			const { toolCallId, toolName, args } = parsed as {
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
			};
			const idx = toolCallIndex.get(toolCallId);
			if (idx !== undefined) {
				stream.toolCallsData[idx].args = args;
			}
			emit("tool_call_args", JSON.stringify({ toolCallId, toolName, args }));
			break;
		}

		case "tool_result": {
			const { toolCallId, result, isError } = parsed as {
				toolCallId: string;
				result: string;
				isError: boolean;
			};
			const idx = toolCallIndex.get(toolCallId);
			if (idx !== undefined) {
				stream.toolCallsData[idx].result = result;
				stream.toolCallsData[idx].isError = isError;
			}
			emit("tool_result", JSON.stringify({ toolCallId, result, isError }));
			break;
		}

		case "thinking_start": {
			emit("thinking_start", JSON.stringify({}));
			break;
		}

		case "thinking_delta": {
			emit("thinking_delta", JSON.stringify({ text: parsed.text }));
			break;
		}

		case "error": {
			if (parsed.error) {
				emit("error", JSON.stringify({ error: parsed.error }));
			}
			break;
		}
	}
}

/** Read the CLI stream, dispatch events, and persist on completion */
async function consumeStream(
	stream: ActiveStream,
	cliStream: ReadableStream<Uint8Array>,
	db: PrismaClient,
	emit: (event: string, data: string) => void,
): Promise<void> {
	const reader = cliStream.getReader();
	const decoder = new TextDecoder();
	const toolCallIndex = new Map<string, number>();
	let buffer = "";
	let currentEventType = "content";

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

				if (!trimmed.startsWith("data: ")) continue;
				const data = trimmed.slice(6);

				if (data === "[DONE]") {
					await safePersist(db, stream.conversationId, stream);
					stream.status = "complete";
					emit("done", "[DONE]");
					return;
				}

				try {
					const parsed = JSON.parse(data);
					dispatchEvent(stream, toolCallIndex, emit, currentEventType, parsed);
				} catch {
					// Skip unparseable
				}

				currentEventType = "content";
			}
		}

		// Stream ended without [DONE]
		await safePersist(db, stream.conversationId, stream);
		stream.status = "complete";
		emit("done", "[DONE]");
	} catch (error) {
		log.error("stream-manager — streaming error", error);
		await safePersist(db, stream.conversationId, stream);
		stream.status = "error";
		emit("error", JSON.stringify({ error: "Stream failed" }));
		emit("done", "[DONE]");
	} finally {
		reader.releaseLock();
		setTimeout(() => {
			activeStreams.delete(stream.conversationId);
			log.info(`stream-manager — cleaned up stream for ${stream.conversationId}`);
		}, CLEANUP_DELAY_MS);
	}
}

/**
 * Start a background stream consumer that reads from a CLI ReadableStream,
 * buffers SSE events, persists the result to DB on completion, and notifies
 * any subscribed SSE clients.
 */
export function startStream(
	conversationId: string,
	cliStream: ReadableStream<Uint8Array>,
	db: PrismaClient,
): ActiveStream {
	// Guard: return existing stream if one is already running for this conversation
	const existing = activeStreams.get(conversationId);
	if (existing && existing.status === "streaming") {
		log.warn(`stream-manager — stream already active for ${conversationId}, returning existing`);
		return existing;
	}

	const stream: ActiveStream = {
		conversationId,
		events: [],
		status: "streaming",
		fullContent: "",
		toolCallsData: [],
		subscribers: new Set(),
		done: Promise.resolve(), // replaced below
	};

	function emit(event: string, data: string): void {
		stream.events.push({ event, data });
		for (const cb of stream.subscribers) {
			try {
				cb(event, data);
			} catch {
				// subscriber errored, ignore
			}
		}
	}

	stream.done = consumeStream(stream, cliStream, db, emit);

	activeStreams.set(conversationId, stream);
	log.info(`stream-manager — started stream for ${conversationId}`);
	return stream;
}

/** Get an active stream if one exists */
export function getStream(conversationId: string): ActiveStream | undefined {
	return activeStreams.get(conversationId);
}

export interface SubscribeHandle {
	/** Unsubscribe from the stream */
	unsubscribe: () => void;
	/** Resolves when all events (replay + live) have been delivered to the callback */
	delivered: Promise<void>;
}

/**
 * Subscribe to a stream. Sends all buffered events first, then live events.
 * Uses an internal queue to ensure ordered delivery even when the callback is async.
 * Returns a handle with unsubscribe + delivered promise, or null if no stream exists.
 */
export function subscribe(conversationId: string, cb: Subscriber): SubscribeHandle | null {
	const stream = activeStreams.get(conversationId);
	if (!stream) return null;

	// Queue-based delivery ensures events are sent in order, even for async callbacks
	const queue: BufferedEvent[] = [];
	let draining = false;
	let active = true;
	let resolveDelivered: () => void;
	const delivered = new Promise<void>((resolve) => {
		resolveDelivered = resolve;
	});

	async function drain() {
		if (draining) return;
		draining = true;
		while (queue.length > 0 && active) {
			const evt = queue.shift();
			if (!evt) break;
			try {
				await cb(evt.event, evt.data);
			} catch {
				// subscriber errored, ignore
			}
		}
		draining = false;
		// If the stream is done and we've delivered everything, resolve
		if (stream && stream.status !== "streaming" && queue.length === 0) {
			resolveDelivered();
		}
	}

	function enqueue(event: string, data: string) {
		queue.push({ event, data });
		drain();
	}

	// Replay buffered events through the queue
	for (const { event, data } of stream.events) {
		enqueue(event, data);
	}

	// If already complete, just let the queue drain — no live subscription needed
	if (stream.status !== "streaming") {
		return {
			unsubscribe: () => {
				active = false;
				resolveDelivered();
			},
			delivered,
		};
	}

	// Add live subscriber that goes through the queue for ordered delivery
	stream.subscribers.add(enqueue);
	return {
		unsubscribe: () => {
			active = false;
			stream.subscribers.delete(enqueue);
			resolveDelivered();
		},
		delivered,
	};
}
