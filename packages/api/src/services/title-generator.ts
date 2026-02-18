import { createLogger } from "@cramkit/shared";
import type { PrismaClient } from "@prisma/client";
import { chatCompletion } from "./llm-client.js";

const log = createLogger("api");

/**
 * Generate an LLM title for a conversation after its first exchange.
 * Returns the generated title, or null if skipped (not first exchange,
 * user-renamed, or LLM failure — the truncated fallback from
 * autoTitleConversation remains in that case).
 */
export async function generateConversationTitle(
	db: PrismaClient,
	conversationId: string,
): Promise<string | null> {
	const conv = await db.conversation.findUnique({
		where: { id: conversationId },
		select: { userRenamed: true },
	});
	if (!conv || conv.userRenamed) return null;

	const messages = await db.message.findMany({
		where: { conversationId },
		orderBy: { createdAt: "asc" },
		select: { role: true, content: true },
		take: 3,
	});

	// Only generate on first exchange (1 user + 1 assistant)
	if (messages.length !== 2) return null;

	const userMsg = messages.find((m) => m.role === "user")?.content || "";
	const assistantMsg = messages.find((m) => m.role === "assistant")?.content || "";

	if (!userMsg && !assistantMsg) return null;

	try {
		const raw = await chatCompletion(
			[
				{
					role: "system",
					content:
						"Generate a short, descriptive title (2-6 words) for this study conversation. Output only the title, nothing else. No quotes or punctuation at the start/end.",
				},
				{
					role: "user",
					content: `Student: ${userMsg.slice(0, 500)}\n\nTutor: ${assistantMsg.slice(0, 500)}`,
				},
			],
			{ model: "haiku", maxTokens: 30 },
		);

		const title = raw.trim().replace(/^["']|["']$/g, "");
		if (!title) return null;

		await db.conversation.update({
			where: { id: conversationId },
			data: { title },
		});

		log.info(`title-generator — "${title}" for conversation ${conversationId}`);
		return title;
	} catch (err) {
		log.warn(`title-generator — failed for ${conversationId}`, err);
		return null;
	}
}
