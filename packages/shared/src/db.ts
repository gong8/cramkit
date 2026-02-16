import { PrismaClient } from "@prisma/client";
import { createLogger } from "./logger.js";

const log = createLogger("db");

let prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
	if (!prisma) {
		log.debug("Initializing PrismaClient");
		prisma = new PrismaClient();
	}
	return prisma;
}

export { PrismaClient };
