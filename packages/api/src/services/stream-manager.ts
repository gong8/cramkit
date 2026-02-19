import type { PrismaClient } from "@cramkit/shared";
import { createLogger } from "@cramkit/shared";
import { enqueueEnrichment } from "../lib/queue.js";
import type { ToolCallData } from "./cli-chat.js";
import { LineBuffer } from "./line-buffer.js";
import { generateConversationTitle } from "./title-generator.js";

const log = createLogger("api");

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

function stripToolCallXml(text: string): string {
	return text
		.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
		.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const CLEANUP_DELAY_MS = 60_000;

const activeStreams = new Map<string, ActiveStream>();

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

function updateStreamState(
	stream: ActiveStream,
	toolCallIndex: Map<string, number>,
	eventType: string,
	parsed: Record<string, unknown>,
): void {
	if (eventType === "content" && parsed.content) {
		stream.fullContent += parsed.content;
		return;
	}

	if (eventType === "tool_call_start") {
		const idx = stream.toolCallsData.length;
		stream.toolCallsData.push({
			toolCallId: parsed.toolCallId as string,
			toolName: parsed.toolName as string,
			args: {},
		});
		toolCallIndex.set(parsed.toolCallId as string, idx);
		return;
	}

	const idx = toolCallIndex.get(parsed.toolCallId as string);
	if (idx === undefined) return;

	if (eventType === "tool_call_args") {
		stream.toolCallsData[idx].args = parsed.args as Record<string, unknown>;
	} else if (eventType === "tool_result") {
		stream.toolCallsData[idx].result = parsed.result as string;
		stream.toolCallsData[idx].isError = parsed.isError as boolean;
	}
}

function parseSSELine(
	line: string,
	currentEventType: { value: string },
): { type: string; data: string } | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("event: ")) {
		currentEventType.value = trimmed.slice(7);
		return null;
	}

	if (!trimmed.startsWith("data: ")) return null;
	const data = trimmed.slice(6);
	const type = currentEventType.value;
	currentEventType.value = "content";
	return { type, data };
}

function extractAccessedEntities(toolCalls: ToolCallData[]): {
	entities: Array<{ type: string; id: string }>;
	sessionId: string | null;
} {
	const entities: Array<{ type: string; id: string }> = [];
	let sessionId: string | null = null;

	const toolArgMap: Record<string, { type: string; idKey: string }> = {
		get_concept: { type: "concept", idKey: "conceptId" },
		get_chunk: { type: "chunk", idKey: "chunkId" },
		get_resource_info: { type: "resource", idKey: "resourceId" },
		get_resource_content: { type: "resource", idKey: "resourceId" },
	};

	for (const tc of toolCalls) {
		const tool = tc.toolName.replace(/^mcp__cramkit__/, "");
		const args = tc.args;

		if (args.sessionId && typeof args.sessionId === "string") {
			sessionId = args.sessionId;
		}

		const mapping = toolArgMap[tool];
		if (mapping && args[mapping.idKey]) {
			entities.push({ type: mapping.type, id: args[mapping.idKey] as string });
		} else if (tool === "get_related" && args.id && args.type) {
			entities.push({ type: args.type as string, id: args.id as string });
		}
	}

	const seen = new Set<string>();
	const deduped = entities.filter((e) => {
		const key = `${e.type}:${e.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	return { entities: deduped, sessionId };
}

async function maybeEnqueueEnrichment(
	db: PrismaClient,
	conversationId: string,
	toolCalls: ToolCallData[],
): Promise<void> {
	if (toolCalls.length === 0) return;

	const { entities, sessionId: extractedSessionId } = extractAccessedEntities(toolCalls);
	if (entities.length < 2) return;

	let sessionId = extractedSessionId;
	if (!sessionId) {
		const conversation = await db.conversation.findUnique({
			where: { id: conversationId },
			select: { sessionId: true },
		});
		sessionId = conversation?.sessionId ?? null;
	}
	if (!sessionId) return;

	enqueueEnrichment(sessionId, conversationId, entities);
}

async function finalizeStream(
	stream: ActiveStream,
	db: PrismaClient,
	emit: (event: string, data: string) => void,
	status: "complete" | "error",
): Promise<void> {
	await safePersist(db, stream.conversationId, stream);

	if (status === "complete") {
		maybeEnqueueEnrichment(db, stream.conversationId, stream.toolCallsData).catch((e) => {
			log.warn("finalizeStream — enrichment enqueue failed", e);
		});

		// Generate LLM title after first exchange (fire-before-done so the
		// frontend's post-stream refetch picks it up immediately).
		const title = await generateConversationTitle(db, stream.conversationId);
		if (title) {
			emit("title", JSON.stringify({ title }));
		}
	}

	stream.status = status;
	if (status === "error") {
		emit("error", JSON.stringify({ error: "Stream failed" }));
	}
	emit("done", "[DONE]");
}

function scheduleCleanup(conversationId: string): void {
	setTimeout(() => {
		activeStreams.delete(conversationId);
		log.info(`stream-manager — cleaned up stream for ${conversationId}`);
	}, CLEANUP_DELAY_MS);
}

async function consumeStream(
	stream: ActiveStream,
	cliStream: ReadableStream<Uint8Array>,
	db: PrismaClient,
	emit: (event: string, data: string) => void,
): Promise<void> {
	const reader = cliStream.getReader();
	const decoder = new TextDecoder();
	const toolCallIndex = new Map<string, number>();
	const lineBuffer = new LineBuffer();
	const currentEventType = { value: "content" };
	let status: "complete" | "error" = "complete";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			for (const line of lineBuffer.push(decoder.decode(value, { stream: true }))) {
				const parsed = parseSSELine(line, currentEventType);
				if (!parsed || parsed.data === "[DONE]") continue;

				try {
					const obj = JSON.parse(parsed.data);
					updateStreamState(stream, toolCallIndex, parsed.type, obj);
					emit(parsed.type, JSON.stringify(obj));
				} catch {
					// Skip unparseable
				}
			}
		}
	} catch (error) {
		log.error("stream-manager — streaming error", error);
		status = "error";
	} finally {
		reader.releaseLock();
	}

	await finalizeStream(stream, db, emit, status);
	scheduleCleanup(stream.conversationId);
}

function createEmitter(stream: ActiveStream): (event: string, data: string) => void {
	return (event, data) => {
		stream.events.push({ event, data });
		for (const cb of stream.subscribers) {
			try {
				cb(event, data);
			} catch {
				// subscriber errored, ignore
			}
		}
	};
}

export function startStream(
	conversationId: string,
	cliStream: ReadableStream<Uint8Array>,
	db: PrismaClient,
): ActiveStream {
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
		done: Promise.resolve(),
	};

	stream.done = consumeStream(stream, cliStream, db, createEmitter(stream));

	activeStreams.set(conversationId, stream);
	log.info(`stream-manager — started stream for ${conversationId}`);
	return stream;
}

export function getStream(conversationId: string): ActiveStream | undefined {
	return activeStreams.get(conversationId);
}

export interface SubscribeHandle {
	unsubscribe: () => void;
	delivered: Promise<void>;
}

function createEventQueue(cb: Subscriber, onDrained: () => void) {
	const queue: BufferedEvent[] = [];
	let draining = false;
	let active = true;

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
		onDrained();
	}

	return {
		enqueue(event: string, data: string) {
			queue.push({ event, data });
			drain();
		},
		stop() {
			active = false;
		},
		get isEmpty() {
			return queue.length === 0;
		},
	};
}

export function subscribe(conversationId: string, cb: Subscriber): SubscribeHandle | null {
	const stream = activeStreams.get(conversationId);
	if (!stream) return null;

	let resolveDelivered: () => void;
	const delivered = new Promise<void>((resolve) => {
		resolveDelivered = resolve;
	});

	const eq = createEventQueue(cb, () => {
		if (stream.status !== "streaming" && eq.isEmpty) resolveDelivered();
	});

	for (const { event, data } of stream.events) {
		eq.enqueue(event, data);
	}

	if (stream.status === "streaming") {
		stream.subscribers.add(eq.enqueue);
	}

	return {
		unsubscribe: () => {
			eq.stop();
			stream.subscribers.delete(eq.enqueue);
			resolveDelivered();
		},
		delivered,
	};
}
