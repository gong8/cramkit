import { getDb } from "@cramkit/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { amortiseSearchResults } from "../../packages/api/src/services/amortiser.js";
import { cleanDb, seedSessionWithChunks } from "../fixtures/helpers.js";

const db = getDb();

async function seedForAmortiser() {
	const { session, resource, chunks } = await seedSessionWithChunks(db, {
		name: "Amortiser Test Session",
	});

	const concept = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Heat Equation",
			description: "Parabolic PDE modelling diffusion",
			aliases: "diffusion equation",
		},
	});

	return { session, resource, chunks, concept };
}

beforeEach(async () => {
	await cleanDb(db);
});

describe("amortiseSearchResults", () => {
	it("creates chunk-concept relationships", async () => {
		const { session, resource, chunks, concept } = await seedForAmortiser();

		const contentResults = chunks.slice(0, 2).map((c) => ({
			chunkId: c.id,
			resourceId: resource.id,
		}));

		await amortiseSearchResults(session.id, "Heat Equation", contentResults);

		const rels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rels.length).toBeGreaterThan(0);
		for (const rel of rels) {
			expect(rel.sourceType).toBe("chunk");
			expect(rel.targetType).toBe("concept");
			expect(rel.targetId).toBe(concept.id);
		}
	});

	it("createdBy is 'amortised', confidence is 0.6", async () => {
		const { session, resource, chunks } = await seedForAmortiser();

		await amortiseSearchResults(session.id, "Heat Equation", [
			{ chunkId: chunks[0].id, resourceId: resource.id },
		]);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rel).not.toBeNull();
		expect(rel?.createdBy).toBe("amortised");
		expect(rel?.confidence).toBe(0.6);
	});

	it("skips existing relationships", async () => {
		const { session, resource, chunks } = await seedForAmortiser();

		const contentResults = [{ chunkId: chunks[0].id, resourceId: resource.id }];

		await amortiseSearchResults(session.id, "Heat Equation", contentResults);
		const countAfterFirst = await db.relationship.count({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		// Run again — should not create duplicates
		await amortiseSearchResults(session.id, "Heat Equation", contentResults);
		const countAfterSecond = await db.relationship.count({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(countAfterSecond).toBe(countAfterFirst);
	});

	it("caps at 10 new relationships", async () => {
		const { session, resource, chunks } = await seedSessionWithChunks(db, {
			name: "Cap Test",
			chunkCount: 20,
		});

		for (const name of ["Heat Equation", "Heat Transfer", "Heat Diffusion"]) {
			await db.concept.create({
				data: { sessionId: session.id, name, description: "Heat related" },
			});
		}

		const contentResults = chunks.map((c) => ({ chunkId: c.id, resourceId: resource.id }));

		await amortiseSearchResults(session.id, "Heat", contentResults);

		const rels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rels.length).toBeLessThanOrEqual(10);
	});

	it("does nothing when no concepts match query", async () => {
		const { session, resource, chunks } = await seedForAmortiser();

		await amortiseSearchResults(session.id, "quantum mechanics", [
			{ chunkId: chunks[0].id, resourceId: resource.id },
		]);

		const rels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rels.length).toBe(0);
	});

	it("does nothing when no content results", async () => {
		const { session } = await seedForAmortiser();

		await amortiseSearchResults(session.id, "Heat Equation", []);

		const rels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rels.length).toBe(0);
	});

	it("never throws", async () => {
		// Even with invalid session ID, amortiser should swallow errors
		await expect(
			amortiseSearchResults("nonexistent-session", "test", [
				{ chunkId: "bad-id", resourceId: "bad-id" },
			]),
		).resolves.toBeUndefined();
	});
});
