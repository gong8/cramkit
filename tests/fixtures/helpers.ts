import type { Mock } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getDb } from "@cramkit/shared";

/** Cast a vi.fn() or vi.mocked() to its Mock type for type-safe assertions */
export function asMock<T extends (...args: any[]) => any>(fn: T): Mock<T> {
	return fn as unknown as Mock<T>;
}

/** Seed a full PDE midterm session with 11 resources (each with 1 file) and chunks. Returns DB IDs. */
export async function seedPdeSession(db: PrismaClient) {
	const session = await db.session.create({
		data: {
			name: "PDE Midterm Revision",
			module: "MATH3083 — Partial Differential Equations",
		},
	});

	const resourceSpecs = [
		{ name: "PDE Lectures Part 1", filename: "PDE_Lectures_Part1.pdf", type: "LECTURE_NOTES" as const, chunkContent: "This chapter introduces the Method of Characteristics for solving first-order partial differential equations. We begin with the heat equation (also known as the diffusion equation) and derive separation of variables techniques." },
		{ name: "PDE Lectures Part 2", filename: "PDE_Lectures_Part2.pdf", type: "LECTURE_NOTES" as const, chunkContent: "We study the wave equation and d'Alembert's solution. Fourier series representations are used extensively. Sturm-Liouville theory provides the eigenfunction framework for boundary value problems." },
		{ name: "PDE Problem Sheet 1", filename: "PDE_Sheet_1.pdf", type: "PROBLEM_SHEET" as const, chunkContent: "Q1. Use the method of characteristics to solve the transport equation ut + cux = 0. Q2. Apply separation of variables to the heat equation on [0,L] with Dirichlet conditions." },
		{ name: "PDE Problem Sheet 2", filename: "PDE_Sheet_2.pdf", type: "PROBLEM_SHEET" as const, chunkContent: "Q1. Find the Fourier series of f(x) = x on [-π,π]. Q2. Solve the wave equation using d'Alembert's formula with given initial data." },
		{ name: "PDE Problem Sheet 3", filename: "PDE_Sheet_3.pdf", type: "PROBLEM_SHEET" as const, chunkContent: "Q1. Solve Laplace's equation on the unit disk using separation of variables. Q2. Prove the maximum principle for harmonic functions." },
		{ name: "PDE Problem Sheet 4", filename: "PDE_Sheet_4.pdf", type: "PROBLEM_SHEET" as const, chunkContent: "Q1. Construct the Green's function for the Dirichlet problem on a half-space. Q2. Apply energy methods to prove uniqueness for the wave equation." },
		{ name: "PDE 2020 Exam", filename: "PDE_2020.pdf", type: "PAST_PAPER" as const, chunkContent: "Q1(a) Solve using the method of characteristics: ut + xux = 0. Q1(b) Discuss well-posedness in the sense of Hadamard. Q2 Solve the heat equation with initial condition u(x,0) = sin(πx)." },
		{ name: "PDE 2021 Exam", filename: "PDE_2021.pdf", type: "PAST_PAPER" as const, chunkContent: "Q1 Apply separation of variables to solve the wave equation on [0,1]. Q2 State and prove the maximum principle for the heat equation." },
		{ name: "PDE 2022 Exam", filename: "PDE_2022.pdf", type: "PAST_PAPER" as const, chunkContent: "Q1(a) Compute the Fourier transform of a Gaussian. Q2 Use Green's function to solve the Poisson equation on a bounded domain." },
		{ name: "PDE 2023 Exam", filename: "PDE_2023.pdf", type: "PAST_PAPER" as const, chunkContent: "Q1 Apply the method of characteristics to a nonlinear first-order PDE. Q2 Use energy methods to establish stability of solutions to the wave equation." },
		{ name: "PDE 2024 Exam", filename: "PDE_2024.pdf", type: "PAST_PAPER" as const, chunkContent: "Q1(a) Define Sturm-Liouville problems and state their spectral properties. Q2 Solve boundary value problems using eigenfunction expansions and Fourier series." },
	];

	const resources: Array<Awaited<ReturnType<typeof db.resource.create>>> = [];
	const chunks: Array<Awaited<ReturnType<typeof db.chunk.create>>> = [];

	for (const spec of resourceSpecs) {
		const resource = await db.resource.create({
			data: {
				sessionId: session.id,
				name: spec.name,
				type: spec.type,
				isIndexed: true,
				isGraphIndexed: false,
				files: {
					create: {
						filename: spec.filename,
						role: "PRIMARY",
						rawPath: `/data/sessions/${session.id}/resources/${spec.name}/raw/${spec.filename}`,
					},
				},
			},
			include: { files: true },
		});
		resources.push(resource);

		const chunk = await db.chunk.create({
			data: {
				resourceId: resource.id,
				index: 0,
				title: spec.name,
				content: spec.chunkContent,
			},
		});
		chunks.push(chunk);
	}

	return { session, resources, chunks };
}

/** Delete all rows from all tables (in FK-safe order) */
export async function cleanDb(db: PrismaClient) {
	await db.indexJob.deleteMany();
	await db.indexBatch.deleteMany();
	await db.relationship.deleteMany();
	await db.concept.deleteMany();
	await db.chunk.deleteMany();
	await db.file.deleteMany();
	await db.resource.deleteMany();
	await db.session.deleteMany();
}
