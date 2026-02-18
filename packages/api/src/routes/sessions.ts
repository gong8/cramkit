import { createLogger, createSessionSchema, getDb, updateSessionSchema } from "@cramkit/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { exportSession } from "../services/session-export.js";
import { importSession } from "../services/session-import.js";

const log = createLogger("api");

export const sessionsRoutes = new Hono();

async function findSessionOr404(c: Context, id: string) {
	const db = getDb();
	const session = await db.session.findUnique({ where: { id } });
	if (!session) return c.json({ error: "Session not found" }, 404);
	return session;
}

function validateOrError<T>(
	c: Context,
	schema: {
		safeParse: (
			d: unknown,
		) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } };
	},
	body: unknown,
) {
	const parsed = schema.safeParse(body);
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	return { data: parsed.data };
}

// List sessions
sessionsRoutes.get("/", async (c) => {
	const db = getDb();
	const sessions = await db.session.findMany({
		include: { _count: { select: { resources: true } } },
		orderBy: { updatedAt: "desc" },
	});

	log.info(`GET /sessions — found ${sessions.length} sessions`);
	return c.json(
		sessions.map((s) => ({
			id: s.id,
			name: s.name,
			module: s.module,
			examDate: s.examDate,
			resourceCount: s._count.resources,
			scope: s.scope,
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
		})),
	);
});

// Get session detail
sessionsRoutes.get("/:id", async (c) => {
	const db = getDb();
	const session = await db.session.findUnique({
		where: { id: c.req.param("id") },
		include: { resources: { include: { files: true }, orderBy: { createdAt: "desc" } } },
	});

	if (!session) {
		log.warn(`GET /sessions/${c.req.param("id")} — not found`);
		return c.json({ error: "Session not found" }, 404);
	}
	log.info(`GET /sessions/${session.id} — found "${session.name}"`);
	return c.json(session);
});

// Create session
sessionsRoutes.post("/", async (c) => {
	const db = getDb();
	const result = validateOrError(c, createSessionSchema, await c.req.json());
	if (result instanceof Response) return result;

	const session = await db.session.create({
		data: {
			...result.data,
			examDate: result.data.examDate ? new Date(result.data.examDate) : undefined,
		},
	});

	log.info(`POST /sessions — created "${session.name}" (${session.id})`);
	return c.json(session, 201);
});

// Update session
sessionsRoutes.patch("/:id", async (c) => {
	const db = getDb();
	const result = validateOrError(c, updateSessionSchema, await c.req.json());
	if (result instanceof Response) return result;

	const data: Record<string, unknown> = { ...result.data };
	if (typeof data.examDate === "string") {
		data.examDate = new Date(data.examDate as string);
	}

	const session = await db.session.update({
		where: { id: c.req.param("id") },
		data,
	});

	log.info(`PATCH /sessions/${session.id} — updated`);
	return c.json(session);
});

// Clear knowledge graph for a session
sessionsRoutes.delete("/:id/graph", async (c) => {
	const db = getDb();
	const id = c.req.param("id");
	const result = await findSessionOr404(c, id);
	if (result instanceof Response) return result;

	await db.$transaction([
		db.concept.deleteMany({ where: { sessionId: id } }),
		db.relationship.deleteMany({ where: { sessionId: id } }),
		db.resource.updateMany({
			where: { sessionId: id },
			data: { isGraphIndexed: false, graphIndexDurationMs: null },
		}),
	]);

	log.info(`DELETE /sessions/${id}/graph — cleared knowledge graph`);
	return c.json({ ok: true });
});

// Export session as .cramkit.zip
sessionsRoutes.get("/:id/export", async (c) => {
	const id = c.req.param("id");
	const result = await findSessionOr404(c, id);
	if (result instanceof Response) return result;
	const session = result;

	try {
		const zipBuffer = await exportSession(id);
		const filename = `${session.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.cramkit.zip`;

		log.info(
			`GET /sessions/${id}/export — exporting "${session.name}" (${zipBuffer.length} bytes)`,
		);

		return new Response(zipBuffer, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Content-Length": String(zipBuffer.length),
			},
		});
	} catch (error) {
		log.error(`GET /sessions/${id}/export — failed`, error);
		return c.json({ error: "Export failed" }, 500);
	}
});

// Import session from .cramkit.zip
sessionsRoutes.post("/import", async (c) => {
	const body = await c.req.parseBody();
	const file = body.file;

	if (!file || !(file instanceof File)) {
		return c.json(
			{ error: "No file uploaded. Send a .cramkit.zip as multipart 'file' field." },
			400,
		);
	}

	if (!file.name.endsWith(".cramkit.zip")) {
		log.warn(`POST /sessions/import — rejected file "${file.name}" (not .cramkit.zip)`);
	}

	try {
		const buffer = await file.arrayBuffer();
		log.info(`POST /sessions/import — received "${file.name}" (${buffer.byteLength} bytes)`);

		const stats = await importSession(buffer);
		log.info(`POST /sessions/import — imported session ${stats.sessionId}`);
		return c.json(stats, 201);
	} catch (error) {
		log.error("POST /sessions/import — failed", error);
		const message = error instanceof Error ? error.message : "Import failed";
		return c.json({ error: message }, 400);
	}
});

// Delete session
sessionsRoutes.delete("/:id", async (c) => {
	const db = getDb();
	const id = c.req.param("id");
	await db.session.delete({ where: { id } });
	log.info(`DELETE /sessions/${id} — deleted`);
	return c.json({ ok: true });
});
