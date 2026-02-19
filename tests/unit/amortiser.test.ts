import { amortiseRead, amortiseSearchResults } from "../../packages/api/src/services/amortiser.js";
import {
	countAmortisedRels,
	findAmortisedRels,
	seedSessionWithChunks,
	seedSessionWithConcept,
	useTestDb,
} from "../fixtures/helpers.js";

const db = useTestDb();

describe("amortiseSearchResults", () => {
	it("creates chunk-concept relationships", async () => {
		const { session, resource, chunks, concept } = await seedSessionWithConcept(db, {
			name: "Amortiser Test Session",
		});

		const contentResults = chunks.slice(0, 2).map((c) => ({
			chunkId: c.id,
			resourceId: resource.id,
		}));

		await amortiseSearchResults(session.id, "Heat Equation", contentResults);

		const rels = await findAmortisedRels(db, session.id);

		expect(rels.length).toBeGreaterThan(0);
		for (const rel of rels) {
			expect(rel.sourceType).toBe("chunk");
			expect(rel.targetType).toBe("concept");
			expect(rel.targetId).toBe(concept.id);
		}
	});

	it("createdBy is 'amortised', confidence is 0.7 for exact name match", async () => {
		const { session, resource, chunks } = await seedSessionWithConcept(db);

		await amortiseSearchResults(session.id, "Heat Equation", [
			{ chunkId: chunks[0].id, resourceId: resource.id },
		]);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rel).not.toBeNull();
		expect(rel?.createdBy).toBe("amortised");
		expect(rel?.confidence).toBe(0.7);
	});

	it("confidence is 0.6 for partial/substring match in search", async () => {
		const { session, resource, chunks } = await seedSessionWithConcept(db);

		await amortiseSearchResults(session.id, "Heat", [
			{ chunkId: chunks[0].id, resourceId: resource.id },
		]);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rel).not.toBeNull();
		expect(rel?.confidence).toBe(0.6);
	});

	it("skips existing relationships", async () => {
		const { session, resource, chunks } = await seedSessionWithConcept(db);

		const contentResults = [{ chunkId: chunks[0].id, resourceId: resource.id }];

		await amortiseSearchResults(session.id, "Heat Equation", contentResults);
		const countAfterFirst = await countAmortisedRels(db, session.id);

		await amortiseSearchResults(session.id, "Heat Equation", contentResults);
		const countAfterSecond = await countAmortisedRels(db, session.id);

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

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBeLessThanOrEqual(10);
	});

	it("does nothing when no concepts match query", async () => {
		const { session, resource, chunks } = await seedSessionWithConcept(db);

		await amortiseSearchResults(session.id, "quantum mechanics", [
			{ chunkId: chunks[0].id, resourceId: resource.id },
		]);

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("does nothing when no content results", async () => {
		const { session } = await seedSessionWithConcept(db);

		await amortiseSearchResults(session.id, "Heat Equation", []);

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("never throws", async () => {
		await expect(
			amortiseSearchResults("nonexistent-session", "test", [
				{ chunkId: "bad-id", resourceId: "bad-id" },
			]),
		).resolves.toBeUndefined();
	});
});

describe("amortiseRead", () => {
	it("creates relationships when concept name appears in matchText", async () => {
		const { session, chunks, concept } = await seedSessionWithConcept(db);

		const entities = chunks.slice(0, 2).map((c) => ({
			type: "chunk" as const,
			id: c.id,
			label: c.title,
		}));

		await amortiseRead(session.id, entities, "The Heat Equation is fundamental");

		const rels = await findAmortisedRels(db, session.id);

		expect(rels.length).toBe(2);
		for (const rel of rels) {
			expect(rel.sourceType).toBe("chunk");
			expect(rel.targetType).toBe("concept");
			expect(rel.targetId).toBe(concept.id);
		}
	});

	it("confidence is 0.5, createdBy is 'amortised'", async () => {
		const { session, chunks } = await seedSessionWithConcept(db);

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"Heat Equation overview",
		);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised" },
		});

		expect(rel).not.toBeNull();
		expect(rel?.createdBy).toBe("amortised");
		expect(rel?.confidence).toBe(0.5);
	});

	it("confidence is 0.7 when concept name is in both title and content", async () => {
		const { session, chunks, concept } = await seedSessionWithConcept(db);

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: "Heat Equation Overview" }],
			"The Heat Equation is fundamental to thermal analysis",
		);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised", targetId: concept.id },
		});

		expect(rel).not.toBeNull();
		expect(rel?.confidence).toBe(0.7);
	});

	it("confidence is 0.65 when concept name is in title but matched via alias in content", async () => {
		const { session, chunks, concept } = await seedSessionWithConcept(db);

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: "Heat Equation Overview" }],
			"The diffusion equation describes thermal diffusion",
		);

		const rel = await db.relationship.findFirst({
			where: { sessionId: session.id, createdBy: "amortised", targetId: concept.id },
		});

		expect(rel).not.toBeNull();
		expect(rel?.confidence).toBe(0.65);
	});

	it("matches concept aliases", async () => {
		const { session, chunks, concept } = await seedSessionWithConcept(db);

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"The diffusion equation describes heat flow",
		);

		const rels = await findAmortisedRels(db, session.id);

		expect(rels.length).toBe(1);
		expect(rels[0].targetId).toBe(concept.id);
	});

	it("skips concepts with names shorter than 3 chars", async () => {
		const { session, chunks } = await seedSessionWithChunks(db);

		await db.concept.create({
			data: { sessionId: session.id, name: "PD", description: "Too short" },
		});

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"PD is mentioned here",
		);

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("skips aliases shorter than 3 chars", async () => {
		const { session, chunks } = await seedSessionWithChunks(db);

		await db.concept.create({
			data: {
				sessionId: session.id,
				name: "Partial Differential Equation",
				description: "A PDE",
				aliases: "PDE, DE, partial diff eq",
			},
		});

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"The DE is simple",
		);

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("matches aliases with whitespace and mixed case", async () => {
		const { session, chunks } = await seedSessionWithChunks(db);

		const concept = await db.concept.create({
			data: {
				sessionId: session.id,
				name: "Navier-Stokes Equations",
				description: "Fluid dynamics equations",
				aliases: "  NSE ,  navier stokes , fluid equations  ",
			},
		});

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"The navier stokes system governs fluid flow",
		);

		const rels = await findAmortisedRels(db, session.id);

		expect(rels.length).toBe(1);
		expect(rels[0].targetId).toBe(concept.id);
	});

	it("deduplicates — second call creates no new rels", async () => {
		const { session, chunks } = await seedSessionWithConcept(db);

		const entities = [{ type: "chunk" as const, id: chunks[0].id, label: chunks[0].title }];
		const text = "Heat Equation stuff";

		await amortiseRead(session.id, entities, text);
		const countFirst = await countAmortisedRels(db, session.id);

		await amortiseRead(session.id, entities, text);
		const countSecond = await countAmortisedRels(db, session.id);

		expect(countSecond).toBe(countFirst);
	});

	it("caps at 10 relationships", async () => {
		const { session, chunks } = await seedSessionWithChunks(db, { chunkCount: 20 });

		for (const name of ["Heat Equation", "Heat Transfer", "Heat Diffusion"]) {
			await db.concept.create({
				data: { sessionId: session.id, name, description: "Heat related" },
			});
		}

		const entities = chunks.map((c) => ({
			type: "chunk" as const,
			id: c.id,
			label: c.title,
		}));

		await amortiseRead(session.id, entities, "Heat Equation Heat Transfer Heat Diffusion");

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBeLessThanOrEqual(10);
	});

	it("does nothing when no concepts match", async () => {
		const { session, chunks } = await seedSessionWithConcept(db);

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"quantum mechanics is unrelated",
		);

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("does nothing on empty entities", async () => {
		const { session } = await seedSessionWithConcept(db);

		await amortiseRead(session.id, [], "Heat Equation");

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("does nothing on empty matchText", async () => {
		const { session, chunks } = await seedSessionWithConcept(db);

		await amortiseRead(
			session.id,
			[{ type: "chunk", id: chunks[0].id, label: chunks[0].title }],
			"",
		);

		const rels = await findAmortisedRels(db, session.id);
		expect(rels.length).toBe(0);
	});

	it("never throws", async () => {
		await expect(
			amortiseRead("nonexistent-session", [{ type: "chunk", id: "bad", label: null }], "test"),
		).resolves.toBeUndefined();
	});
});
