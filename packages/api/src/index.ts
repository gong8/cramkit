import { createLogger, initDb } from "@cramkit/shared";
import { Hono } from "hono";
import { resumeInterruptedBatches } from "./lib/queue.js";
import { cors } from "./middleware/cors.js";
import { chatRoutes } from "./routes/chat.js";
import { chunksRoutes } from "./routes/chunks.js";
import { graphRoutes } from "./routes/graph.js";
import { relationshipsRoutes } from "./routes/relationships.js";
import { resourcesRoutes } from "./routes/resources.js";
import { searchRoutes } from "./routes/search.js";
import { sessionsRoutes } from "./routes/sessions.js";

const log = createLogger("api");

await initDb();
await resumeInterruptedBatches();

const app = new Hono();

app.use("*", cors());

app.route("/sessions", sessionsRoutes);
app.route("/resources", resourcesRoutes);
app.route("/chunks", chunksRoutes);
app.route("/relationships", relationshipsRoutes);
app.route("/search", searchRoutes);
app.route("/graph", graphRoutes);
app.route("/chat", chatRoutes);

app.get("/", (c) => c.json({ name: "cramkit-api", version: "0.0.1" }));

const port = Number(process.env.PORT) || 8787;
log.info(`CramKit API running on http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch,
	idleTimeout: 120,
};
