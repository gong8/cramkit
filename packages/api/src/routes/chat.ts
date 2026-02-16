import { chatStreamRequestSchema, createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const log = createLogger("api");

const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:3456/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || "proxy-mode-no-key-required";
const LLM_MODEL = process.env.LLM_MODEL || "claude-opus-4-6";

export const chatRoutes = new Hono();

chatRoutes.post("/stream", async (c) => {
	const body = await c.req.json();
	const parsed = chatStreamRequestSchema.safeParse(body);

	if (!parsed.success) {
		log.warn("POST /chat/stream — validation failed", parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { sessionId, messages } = parsed.data;
	const db = getDb();

	// Build system prompt from session context
	const session = await db.session.findUnique({
		where: { id: sessionId },
		include: {
			files: {
				select: {
					id: true,
					filename: true,
					type: true,
					label: true,
					isIndexed: true,
					isGraphIndexed: true,
				},
			},
		},
	});

	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	// Get file links (file-to-file relationships)
	const fileLinks = await db.relationship.findMany({
		where: {
			sessionId,
			sourceType: "file",
			targetType: "file",
		},
		select: {
			sourceId: true,
			targetId: true,
			relationship: true,
		},
	});

	const fileListStr = session.files
		.map((f) => {
			const links = fileLinks
				.filter((l) => l.sourceId === f.id)
				.map((l) => {
					const target = session.files.find((t) => t.id === l.targetId);
					return `→ ${l.relationship}: ${target?.label || target?.filename || l.targetId}`;
				});
			const linkStr = links.length > 0 ? ` (${links.join(", ")})` : "";
			return `- ${f.label || f.filename} [${f.type}]${linkStr}`;
		})
		.join("\n");

	const systemPrompt = `You are a study assistant for CramKit. You are helping a student prepare for their exam.

Session: ${session.name}
${session.module ? `Module: ${session.module}` : ""}
${session.examDate ? `Exam date: ${new Date(session.examDate).toLocaleDateString()}` : ""}
${session.scope ? `Exam scope: ${session.scope}` : ""}
${session.notes ? `Student notes: ${session.notes}` : ""}

Uploaded materials:
${fileListStr || "No files uploaded yet."}

Help the student study effectively. You can reference their materials by name. Be concise and focused on exam preparation. If asked about specific content from their files, explain that you can see what files they have but would need the MCP tools to read specific content.`;

	log.info(`POST /chat/stream — session=${sessionId}, messages=${messages.length}`);

	// Call LLM with streaming
	const llmResponse = await fetch(`${LLM_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${LLM_API_KEY}`,
		},
		body: JSON.stringify({
			model: LLM_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				...messages,
			],
			stream: true,
			temperature: 0.7,
			max_tokens: 4096,
		}),
	});

	if (!llmResponse.ok) {
		const errorText = await llmResponse.text();
		log.error(`POST /chat/stream — LLM error ${llmResponse.status}: ${errorText}`);
		return c.json({ error: `LLM error: ${llmResponse.status}` }, 502);
	}

	// Stream SSE to client
	return streamSSE(c, async (stream) => {
		const reader = llmResponse.body?.getReader();
		if (!reader) {
			await stream.writeSSE({ data: JSON.stringify({ error: "No response body" }), event: "error" });
			return;
		}

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;

					const data = trimmed.slice(6);
					if (data === "[DONE]") {
						await stream.writeSSE({ data: "[DONE]", event: "done" });
						return;
					}

					try {
						const parsed = JSON.parse(data) as {
							choices?: Array<{
								delta?: { content?: string };
								finish_reason?: string | null;
							}>;
						};
						const content = parsed.choices?.[0]?.delta?.content;
						if (content) {
							await stream.writeSSE({
								data: JSON.stringify({ content }),
								event: "content",
							});
						}
						if (parsed.choices?.[0]?.finish_reason === "stop") {
							await stream.writeSSE({ data: "[DONE]", event: "done" });
							return;
						}
					} catch {
						// Skip unparseable chunks
					}
				}
			}
		} catch (error) {
			log.error("POST /chat/stream — streaming error", error);
		} finally {
			reader.releaseLock();
		}
	});
});
