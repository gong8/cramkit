import { cors as honoCors } from "hono/cors";

export const cors = () =>
	honoCors({
		origin: "*",
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	});
