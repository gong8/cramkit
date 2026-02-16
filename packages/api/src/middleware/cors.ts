import { createLogger } from "@cramkit/shared";
import { createMiddleware } from "hono/factory";

const log = createLogger("api");

export function cors() {
	return createMiddleware(async (c, next) => {
		c.header("Access-Control-Allow-Origin", "*");
		c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
		c.header("Access-Control-Allow-Headers", "Content-Type");

		if (c.req.method === "OPTIONS") {
			log.debug(`CORS preflight — ${c.req.url}`);
			return c.body(null, 204);
		}

		await next();
	});
}
