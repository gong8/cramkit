import { createMiddleware } from "hono/factory";

export function cors() {
	return createMiddleware(async (c, next) => {
		c.header("Access-Control-Allow-Origin", "*");
		c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
		c.header("Access-Control-Allow-Headers", "Content-Type");

		if (c.req.method === "OPTIONS") {
			return c.body(null, 204);
		}

		await next();
	});
}
