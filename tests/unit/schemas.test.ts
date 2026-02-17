import { describe, it, expect } from "vitest";
import { createConceptSchema, indexResourceRequestSchema } from "@cramkit/shared";

describe("createConceptSchema", () => {
	it("accepts valid input", () => {
		const result = createConceptSchema.safeParse({
			name: "Heat Equation",
			description: "Parabolic PDE",
			aliases: "diffusion equation",
			createdBy: "system",
		});
		expect(result.success).toBe(true);
	});

	it("accepts minimal input (name only)", () => {
		const result = createConceptSchema.safeParse({ name: "Wave Equation" });
		expect(result.success).toBe(true);
	});

	it("rejects empty name", () => {
		const result = createConceptSchema.safeParse({ name: "" });
		expect(result.success).toBe(false);
	});

	it("rejects invalid createdBy", () => {
		const invalid = createConceptSchema.safeParse({ name: "Test", createdBy: "user" });
		expect(invalid.success).toBe(false);

		for (const validValue of ["system", "claude", "amortised"]) {
			const valid = createConceptSchema.safeParse({ name: "Test", createdBy: validValue });
			expect(valid.success).toBe(true);
		}
	});
});

describe("indexResourceRequestSchema", () => {
	it("accepts valid resourceId", () => {
		const result = indexResourceRequestSchema.safeParse({ resourceId: "clxyz123" });
		expect(result.success).toBe(true);
	});

	it("rejects missing resourceId", () => {
		const result = indexResourceRequestSchema.safeParse({});
		expect(result.success).toBe(false);
	});
});
