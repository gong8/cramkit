import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@cramkit/shared";
import { cleanDb } from "../fixtures/helpers";
import { amortiseSearchResults } from "../../packages/api/src/services/amortiser.js";

const db = getDb();

async function seedForAmortiser() {
	const session = await db.session.create({
		data: { name: "Amortiser Test Session" },
	});

	const file = await db.file.create({
		data: {
			sessionId: session.id,
			filename: "test.pdf",
			type: "LECTURE_NOTES",
			rawPath: "/tmp/test.pdf",
			isIndexed: true,
		},
	});

	const chunks = [];
	for (let i = 0; i < 5; i++) {
		chunks.push(
			await db.chunk.create({
				data: {
					fileId: file.id,
					index: i,
					content: `Chunk content ${i}`,
				},
			}),
		);
	}

	const concept = await db.concept.create({
		data: {
			sessionId: session.id,
			name: "Heat Equation",
			description: "Parabolic PDE modelling diffusion",
			aliases: "diffusion equation",
		},
	});

	return { session, file, chunks, concept };
}

beforeEach(async () => {
	await cleanDb(db);
});

describe("amortiseSearchResults", () => {
	it("creates chunk-concept relationships", async () => {
		const { session, chunks, concept } = await seedForAmortiser();

		const contentResults = chunks.slice(0, 2).map((c) => ({
			chunkId: c.id,
			fileId: c.fileId,
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
		const { session, chunks } = await seedForAmortiser();

		await amortiseSearchResults(session.id, "Heat Equation", [
			{ chunkId: chunks[0].id, fileId: chunks[0].fileId },
		]);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rel).not.toBeNull();
		expect(rel!.createdBy).toBe("amortised");
		expect(rel!.confidence).toBe(0.6);
	});

	it("skips existing relationships", async () => {
		const { session, chunks, concept } = await seedForAmortiser();

		const contentResults = [{ chunkId: chunks[0].id, fileId: chunks[0].fileId }];

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
		const session = await db.session.create({ data: { name: "Cap Test" } });

		const file = await db.file.create({
			data: {
				sessionId: session.id,
				filename: "big.pdf",
				type: "LECTURE_NOTES",
				rawPath: "/tmp/big.pdf",
				isIndexed: true,
			},
		});

		// Create 20 chunks
		const chunks = [];
		for (let i = 0; i < 20; i++) {
			chunks.push(
				await db.chunk.create({
					data: { fileId: file.id, index: i, content: `chunk ${i}` },
				}),
			);
		}

		// Create 3 concepts matching the query
		for (const name of ["Heat Equation", "Heat Transfer", "Heat Diffusion"]) {
			await db.concept.create({
				data: { sessionId: session.id, name, description: "Heat related" },
			});
		}

		const contentResults = chunks.map((c) => ({ chunkId: c.id, fileId: c.fileId }));

		await amortiseSearchResults(session.id, "Heat", contentResults);

		const rels = await db.relationship.findMany({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rels.length).toBeLessThanOrEqual(10);
	});

	it("does nothing when no concepts match query", async () => {
		const { session, chunks } = await seedForAmortiser();

		await amortiseSearchResults(session.id, "quantum mechanics", [
			{ chunkId: chunks[0].id, fileId: chunks[0].fileId },
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
				{ chunkId: "bad-id", fileId: "bad-id" },
			]),
		).resolves.toBeUndefined();
	});
});
