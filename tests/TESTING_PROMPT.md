# CramKit Test Writing Prompt

## Instructions

Write tests for CramKit's knowledge graph indexing system using Vitest.
Follow the test plan and fixtures below. The codebase uses:
- **Vitest** with globals enabled (describe, it, expect, vi, beforeEach, afterEach)
- **Hono** web framework (use `app.request()` for route testing)
- **Prisma** with SQLite (real test DB, cleaned between tests)
- **vi.mock()** for module-level mocking (LLM client, fetch)
- **Factory pattern** for test data (see fixtures/)

## Key Patterns

### Mocking chatCompletion (most tests need this)
```ts
vi.mock("../../packages/api/src/services/llm-client.js", () => ({
  chatCompletion: vi.fn(),
}))
import { chatCompletion } from "../../packages/api/src/services/llm-client.js"
import { lectureNotesResponse } from "../fixtures/llm-responses"

beforeEach(() => {
  vi.mocked(chatCompletion).mockResolvedValue(JSON.stringify(lectureNotesResponse))
})
```

### DB seeding
```ts
import { seedPdeSession, cleanDb } from "../fixtures/helpers"
import { getDb } from "@cramkit/shared"

const db = getDb()
beforeEach(async () => {
  await cleanDb(db)
})
```

### Route testing with Hono
```ts
import { Hono } from "hono"
import { graphRoutes } from "../../packages/api/src/routes/graph.js"

const app = new Hono()
app.route("/graph", graphRoutes)

const res = await app.request("/graph/sessions/test-session/concepts")
expect(res.status).toBe(200)
const body = await res.json()
```

## Test Data: PDE Midterm

[USER: paste your PDE content snippets here — a paragraph from each lecture notes PDF,
a few problem sheet questions, and a few past paper questions. These become the chunk
content in fixtures/pde-session.ts]

### Expected Concepts (for fixture responses)
- Method Of Characteristics
- Heat Equation / Diffusion Equation
- Wave Equation
- Laplace's Equation
- Separation Of Variables
- Fourier Series
- Fourier Transform
- Green's Function
- Boundary Value Problems
- Initial Value Problems
- D'Alembert's Solution
- Sturm-Liouville Theory
- Well-Posedness (Hadamard)
- Maximum Principle
- Energy Methods

### Expected Relationships
- Separation Of Variables → prerequisite → Fourier Series
- Heat Equation → related_to → Maximum Principle
- D'Alembert's Solution → special_case_of → Wave Equation
- Green's Function → extends → Boundary Value Problems
- Sturm-Liouville Theory → prerequisite → Separation Of Variables
