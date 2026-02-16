import { createLogger, createSessionSchema, getDb, updateSessionSchema } from "@cramkit/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const sessionsRoutes = new Hono();

// List sessions
sessionsRoutes.get("/", async (c) => {
	const db = getDb();
	const sessions = await db.session.findMany({
		include: { _count: { select: { files: true } } },
		orderBy: { updatedAt: "desc" },
	});

	log.info(`GET /sessions — found ${sessions.length} sessions`);
	return c.json(
		sessions.map((s) => ({
			id: s.id,
			name: s.name,
			module: s.module,
			examDate: s.examDate,
			fileCount: s._count.files,
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
		include: { files: true },
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
	const body = await c.req.json();
	const parsed = createSessionSchema.safeParse(body);

	if (!parsed.success) {
		log.warn("POST /sessions — validation failed", parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const session = await db.session.create({
		data: {
			...parsed.data,
			examDate: parsed.data.examDate ? new Date(parsed.data.examDate) : undefined,
		},
	});

	log.info(`POST /sessions — created "${session.name}" (${session.id})`);
	return c.json(session, 201);
});

// Update session
sessionsRoutes.patch("/:id", async (c) => {
	const db = getDb();
	const body = await c.req.json();
	const parsed = updateSessionSchema.safeParse(body);

	if (!parsed.success) {
		log.warn(`PATCH /sessions/${c.req.param("id")} — validation failed`, parsed.error.flatten());
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const data: Record<string, unknown> = { ...parsed.data };
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

// Delete session
sessionsRoutes.delete("/:id", async (c) => {
	const db = getDb();
	const id = c.req.param("id");
	await db.session.delete({ where: { id } });
	log.info(`DELETE /sessions/${id} — deleted`);
	return c.json({ ok: true });
});
