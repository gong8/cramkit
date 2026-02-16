import { createLogger } from "@cramkit/shared";
import { Hono } from "hono";
import { cors } from "./middleware/cors.js";

const log = createLogger("api");
import { chunksRoutes } from "./routes/chunks.js";
import { filesRoutes } from "./routes/files.js";
import { graphRoutes } from "./routes/graph.js";
import { relationshipsRoutes } from "./routes/relationships.js";
import { searchRoutes } from "./routes/search.js";
import { sessionsRoutes } from "./routes/sessions.js";

const app = new Hono();

app.use("*", cors());

app.route("/sessions", sessionsRoutes);
app.route("/files", filesRoutes);
app.route("/chunks", chunksRoutes);
app.route("/relationships", relationshipsRoutes);
app.route("/search", searchRoutes);
app.route("/graph", graphRoutes);

app.get("/", (c) => c.json({ name: "cramkit-api", version: "0.0.1" }));

const port = Number(process.env.PORT) || 8787;
log.info(`CramKit API running on http://localhost:${port}`);

export default {
	port,
	fetch: app.fetch,
};
