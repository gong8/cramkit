import { z } from "zod";

export const sessionId = z.string().describe("The session ID");
export const resourceId = z.string().describe("The resource ID");
export const chunkId = z.string().describe("The chunk ID");
export const conceptId = z.string().describe("The concept ID (from list_concepts or get_related)");
