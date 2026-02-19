import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { createLogger, getDb } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

const DATA_DIR = join(import.meta.dirname, "..", "..", "..", "..", "data");
const ATTACHMENTS_DIR = join(DATA_DIR, "chat-attachments");

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const attachmentRoutes = new Hono();

// Upload an image attachment
attachmentRoutes.post("/", async (c) => {
	const formData = await c.req.formData();
	const file = formData.get("file") as File | null;

	if (!file) {
		return c.json({ error: "No file provided" }, 400);
	}

	if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
		return c.json({ error: "Only JPEG, PNG, GIF, and WebP images are allowed" }, 400);
	}

	const id = randomUUID();
	const ext = extname(file.name) || ".png";
	const diskPath = join(ATTACHMENTS_DIR, `${id}${ext}`);

	await mkdir(ATTACHMENTS_DIR, { recursive: true });
	const buffer = Buffer.from(await file.arrayBuffer());
	await writeFile(diskPath, buffer);

	const db = getDb();
	const attachment = await db.chatAttachment.create({
		data: {
			id,
			filename: file.name,
			contentType: file.type,
			diskPath,
			fileSize: buffer.length,
		},
		select: { id: true, filename: true, contentType: true },
	});

	log.info(`POST /chat/attachments — uploaded ${attachment.filename} (${buffer.length} bytes)`);
	return c.json(
		{
			id: attachment.id,
			url: `/api/chat/attachments/${attachment.id}`,
			filename: attachment.filename,
			contentType: attachment.contentType,
		},
		201,
	);
});

// Serve an attachment image
attachmentRoutes.get("/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const attachment = await db.chatAttachment.findUnique({ where: { id } });
	if (!attachment || !existsSync(attachment.diskPath)) {
		return c.json({ error: "Attachment not found" }, 404);
	}

	const data = await readFile(attachment.diskPath);
	c.header("Content-Type", attachment.contentType);
	c.header("Cache-Control", "public, max-age=31536000, immutable");
	return c.body(data);
});

// Delete an unlinked attachment (e.g. user removed from composer before sending)
attachmentRoutes.delete("/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const attachment = await db.chatAttachment.findUnique({ where: { id } });
	if (!attachment) {
		return c.json({ error: "Attachment not found" }, 404);
	}

	// Only allow deleting unlinked attachments (not yet sent with a message)
	if (attachment.messageId) {
		return c.json({ error: "Cannot delete an attachment that belongs to a message" }, 400);
	}

	await db.chatAttachment.delete({ where: { id } });
	await rm(attachment.diskPath, { force: true });

	log.info(`DELETE /chat/attachments/${id}`);
	return c.json({ ok: true });
});
