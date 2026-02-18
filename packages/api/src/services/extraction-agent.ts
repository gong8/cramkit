import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@cramkit/shared";
import { CancellationError } from "./errors.js";
import { BLOCKED_BUILTIN_TOOLS, LLM_MODEL, getCliModel } from "./llm-client.js";

const log = createLogger("api");

interface ChunkData {
	id: string;
	title: string | null;
	content: string;
	depth: number;
	nodeType: string;
	parentId: string | null;
}

interface ExistingConcept {
	name: string;
	description: string | null;
}

interface ExistingRelationship {
	sourceLabel: string | null;
	targetLabel: string | null;
	relationship: string;
	confidence: number;
}

export interface ExtractionAgentInput {
	resource: { name: string; type: string; label: string | null };
	files: Array<{ filename: string; role: string }>;
	chunks: ChunkData[];
	existingConcepts: ExistingConcept[];
	existingRelationships: Map<string, ExistingRelationship[]>;
	thoroughness: "quick" | "standard" | "thorough";
}

interface ThoroughnessConfig {
	maxTurns: number;
	promptStyle: "selective" | "standard" | "comprehensive";
}

const THOROUGHNESS_CONFIGS: Record<string, ThoroughnessConfig> = {
	quick: { maxTurns: 8, promptStyle: "selective" },
	standard: { maxTurns: 15, promptStyle: "standard" },
	thorough: { maxTurns: 30, promptStyle: "comprehensive" },
};

function generateMcpServerScript(dataDir: string): string {
	return `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const dataDir = ${JSON.stringify(dataDir)};
const chunks = JSON.parse(fs.readFileSync(path.join(dataDir, "chunks.json"), "utf-8"));
const concepts = JSON.parse(fs.readFileSync(path.join(dataDir, "concepts.json"), "utf-8"));
const relationships = JSON.parse(fs.readFileSync(path.join(dataDir, "relationships.json"), "utf-8"));
const resultPath = path.join(dataDir, "result.json");

// Build parent-child map
const childMap = new Map();
for (const c of chunks) {
  if (!childMap.has(c.parentId)) childMap.set(c.parentId, []);
  childMap.get(c.parentId).push(c);
}

function getSubtree(chunk) {
  const result = [chunk];
  const children = childMap.get(chunk.id) || [];
  for (const child of children) {
    result.push(...getSubtree(child));
  }
  return result;
}

function fuzzyMatch(query, title) {
  if (!title) return 0;
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (t === q) return 1;
  if (t.includes(q) || q.includes(t)) return 0.8;
  // Dice coefficient
  if (q.length < 2 || t.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < q.length - 1; i++) {
    const b = q.slice(i, i + 2);
    bigrams.set(b, (bigrams.get(b) || 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    const count = bigrams.get(b);
    if (count > 0) { overlap++; bigrams.set(b, count - 1); }
  }
  return (2 * overlap) / (q.length - 1 + t.length - 1);
}

const tools = [
  {
    name: "get_material_overview",
    description: "Get a hierarchical table of contents of the material. Shows titles, types, depths, and content lengths. Use this first to plan your reading strategy.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_section",
    description: "Read the full content of a section and all its descendants. Use fuzzy title matching.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "Section title to read (fuzzy matched)" } },
      required: ["title"],
    },
  },
  {
    name: "search_material",
    description: "Search across all chunks for a substring. Returns matching snippets with ~200 char context.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Substring to search for" } },
      required: ["query"],
    },
  },
  {
    name: "get_existing_concepts",
    description: "Get concepts already extracted from other resources in this session. Optionally filter by name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional name filter (substring match)" } },
      required: [],
    },
  },
  {
    name: "get_concept_relationships",
    description: "Get all relationships for a specific existing concept.",
    inputSchema: {
      type: "object",
      properties: { conceptName: { type: "string", description: "Exact concept name" } },
      required: ["conceptName"],
    },
  },
  {
    name: "submit_extraction",
    description: "Submit the final extraction result with concepts and relationships. Call this exactly once when done.",
    inputSchema: {
      type: "object",
      properties: {
        concepts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Concept name in Title Case" },
              description: { type: "string", description: "Brief description" },
              aliases: { type: "string", description: "Comma-separated alternative names" },
            },
            required: ["name"],
          },
        },
        file_concept_links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              conceptName: { type: "string" },
              relationship: { type: "string", enum: ["covers", "introduces", "applies", "references", "proves"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              chunkTitle: { type: "string", description: "Section title this concept appears in" },
            },
            required: ["conceptName", "relationship"],
          },
        },
        concept_concept_links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sourceConcept: { type: "string" },
              targetConcept: { type: "string" },
              relationship: { type: "string", enum: ["prerequisite", "related_to", "extends", "generalizes", "special_case_of", "contradicts"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["sourceConcept", "targetConcept", "relationship"],
          },
        },
        question_concept_links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              questionLabel: { type: "string" },
              conceptName: { type: "string" },
              relationship: { type: "string", enum: ["tests", "applies", "requires"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["questionLabel", "conceptName", "relationship"],
          },
        },
      },
      required: ["concepts", "file_concept_links", "concept_concept_links", "question_concept_links"],
    },
  },
];

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const id = req.id;

  switch (req.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "extraction-agent", version: "1.0.0" },
      }});
      break;
    case "notifications/initialized":
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools } });
      break;
    case "tools/call": {
      const name = req.params?.name;
      const args = req.params?.arguments || {};
      let content;

      switch (name) {
        case "get_material_overview": {
          const lines = [];
          function renderToc(parentId, indent) {
            const children = childMap.get(parentId) || [];
            for (const c of children) {
              const prefix = "  ".repeat(indent);
              const label = c.nodeType !== "section" ? "[" + c.nodeType + "] " : "";
              lines.push(prefix + label + (c.title || "(untitled)") + " (" + c.content.length + " chars)");
              renderToc(c.id, indent + 1);
            }
          }
          renderToc(null, 0);
          content = lines.join("\\n") || "No structured content available.";
          break;
        }
        case "read_section": {
          const query = args.title || "";
          let bestChunk = null;
          let bestScore = 0.3;
          for (const c of chunks) {
            const score = fuzzyMatch(query, c.title);
            if (score > bestScore) { bestScore = score; bestChunk = c; }
          }
          if (!bestChunk) {
            content = "No section found matching: " + query;
          } else {
            const subtree = getSubtree(bestChunk);
            const parts = subtree.map(c => {
              const prefix = "  ".repeat(Math.max(0, c.depth - bestChunk.depth));
              const label = c.nodeType !== "section" ? "[" + c.nodeType + "] " : "";
              return prefix + label + (c.title || "(untitled)") + "\\n" + prefix + c.content;
            });
            content = parts.join("\\n\\n");
          }
          break;
        }
        case "search_material": {
          const query = (args.query || "").toLowerCase();
          const results = [];
          for (const c of chunks) {
            const idx = c.content.toLowerCase().indexOf(query);
            if (idx >= 0) {
              const start = Math.max(0, idx - 100);
              const end = Math.min(c.content.length, idx + query.length + 100);
              results.push({
                title: c.title || "(untitled)",
                snippet: "..." + c.content.slice(start, end) + "...",
              });
              if (results.length >= 20) break;
            }
          }
          content = results.length > 0
            ? results.map(r => r.title + ":\\n" + r.snippet).join("\\n\\n")
            : "No matches found for: " + args.query;
          break;
        }
        case "get_existing_concepts": {
          const query = (args.query || "").toLowerCase();
          const filtered = query
            ? concepts.filter(c => c.name.toLowerCase().includes(query))
            : concepts;
          content = filtered.length > 0
            ? filtered.map(c => c.name + (c.description ? ": " + c.description : "")).join("\\n")
            : "No existing concepts" + (query ? " matching: " + args.query : "") + ".";
          break;
        }
        case "get_concept_relationships": {
          const name = args.conceptName || "";
          const rels = relationships[name] || [];
          content = rels.length > 0
            ? rels.map(r => r.sourceLabel + " --[" + r.relationship + "]--> " + r.targetLabel + " (confidence: " + r.confidence + ")").join("\\n")
            : "No relationships found for: " + name;
          break;
        }
        case "submit_extraction": {
          fs.writeFileSync(resultPath, JSON.stringify(args, null, 2));
          content = "Extraction submitted successfully.";
          break;
        }
        default:
          content = "Unknown tool: " + name;
      }

      send({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: content }],
      }});
      break;
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
`;
}

const PROMPT_STYLES: Record<ThoroughnessConfig["promptStyle"], string> = {
	selective: `Strategy: SELECTIVE reading. Focus on the most important sections only.
- Read the overview first, then pick 2-3 key sections to read in detail
- Extract only the most important concepts — skip minor or peripheral topics
- Minimal cross-referencing with existing concepts`,

	standard: `Strategy: STANDARD reading. Read important sections and cross-reference.
- Read the overview, then read all major sections
- Extract meaningful concepts — be selective but don't skip important ones
- Query existing concepts and check for connections`,

	comprehensive: `Strategy: COMPREHENSIVE reading. Read EVERYTHING and build rich connections.
- Read the overview, then read EVERY section in detail
- Extract ALL concepts: definitions, theorems, methods, examples, named results
- Query ALL existing concepts and trace relationships
- Hunt for cross-resource links — look for concepts that appear in multiple resources
- Do gap analysis: after initial extraction, re-read sections to find missed concepts
- Create rich concept-concept relationships`,
};

function buildAgentSystemPrompt(input: ExtractionAgentInput, config: ThoroughnessConfig): string {
	const { resource, files } = input;
	const fileList = files.map((f) => `  - ${f.filename} (${f.role})`).join("\n");

	return `You are a knowledge graph extraction agent for academic study materials. Your job is to analyze the material and extract structured knowledge using the tools provided.

## Resource
Name: ${resource.name}
Type: ${resource.type}${resource.label ? `\nLabel: ${resource.label}` : ""}
Files:
${fileList}

## Workflow
1. Call get_material_overview to see the structure of the material
2. Use read_section to read sections of interest (returns section + all descendants)
3. Use search_material to find specific terms or concepts across the material
4. Use get_existing_concepts to see what concepts exist from other resources in this session
5. Use get_concept_relationships to understand how existing concepts are connected
6. When done, call submit_extraction ONCE with your complete extraction result

## ${PROMPT_STYLES[config.promptStyle]}

## Extraction Schema
When calling submit_extraction, provide:
- **concepts**: Key topics, theorems, definitions, methods. Each has: name (Title Case), description (brief), aliases (comma-separated, optional)
- **file_concept_links**: How this resource relates to each concept. Include chunkTitle for the specific section.
  Relationship types:
  - "introduces": The section presents this concept for the first time with definitions/derivations
  - "covers": The section discusses this concept substantially (proofs, examples, analysis)
  - "applies": The section uses this concept as a tool to solve problems or derive other results
  - "references": The section briefly mentions this concept without substantial treatment
  - "proves": The section contains a formal proof of this concept (theorem, lemma, proposition)
- **concept_concept_links**: Relationships between concepts. Choose the MOST SPECIFIC type:
  - "prerequisite": A must be understood before B. Use when there is a clear logical/mathematical dependency. Example: "Integration" is prerequisite for "Integration by Parts". Direction: source is the prerequisite, target depends on it.
  - "extends": A builds upon B with additional structure or generality. Example: "Fourier Transform" extends "Fourier Series" (from discrete to continuous).
  - "generalizes": A is a more general framework that includes B. Example: "Partial Differential Equation" generalizes "Heat Equation".
  - "special_case_of": A is a specific instance of B. Example: "Laplace's Equation" is special_case_of "Poisson's Equation" (when f=0).
  - "contradicts": A and B are mutually exclusive or represent opposing approaches.
  - "related_to": LAST RESORT ONLY. Use only when the connection is real but none of the above types apply. If you're unsure between "prerequisite" and "related_to", prefer "prerequisite" — it's almost always more accurate for mathematical concepts.
  IMPORTANT: Avoid defaulting to "related_to". For mathematical/scientific content, most connections are either prerequisites, specializations, or extensions. "related_to" should be rare.
- **question_concept_links**: For past papers/problem sheets — which questions test which concepts. relationship: "tests"|"applies"|"requires"

## Rules
- Use Title Case for all concept names
- Reuse exact existing concept names when the same concept appears
- Confidence scoring guide:
  - 0.95-1.0: Explicitly stated relationship (e.g., "X requires Y", "X is a special case of Y when...")
  - 0.85-0.94: Strongly implied by mathematical structure (e.g., a derivation clearly uses concept Y to derive X)
  - 0.70-0.84: Clear conceptual connection requiring moderate inference
  - 0.50-0.69: Tangential or weak connection
  - Below 0.5: Do not create the relationship
  For prerequisite relationships, bias toward higher confidence (0.8+) — if you've identified it as a prerequisite, it's usually a strong one.
  For related_to relationships, confidence should typically be 0.6-0.8 since these are weaker connections by definition.
- For question_concept_links, use the question label as it appears in the material (e.g. "Question 1", "Q1a", "Problem 3")
- You MUST call submit_extraction before finishing — this is how your work is saved`;
}

export interface ExtractionResult {
	concepts: Array<{ name: string; description?: string; aliases?: string }>;
	file_concept_links: Array<{
		conceptName: string;
		relationship: string;
		confidence?: number;
		chunkTitle?: string;
	}>;
	concept_concept_links: Array<{
		sourceConcept: string;
		targetConcept: string;
		relationship: string;
		confidence?: number;
	}>;
	question_concept_links: Array<{
		questionLabel: string;
		conceptName: string;
		relationship: string;
		confidence?: number;
	}>;
}

export async function runExtractionAgent(
	input: ExtractionAgentInput,
	signal?: AbortSignal,
): Promise<ExtractionResult> {
	if (signal?.aborted) throw new CancellationError("Extraction cancelled before start");

	const config = THOROUGHNESS_CONFIGS[input.thoroughness];
	const model = getCliModel(LLM_MODEL);

	const tempDir = join(tmpdir(), `cramkit-agent-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	log.info(
		`runExtractionAgent — "${input.resource.name}" [${input.thoroughness}] maxTurns=${config.maxTurns}`,
	);

	try {
		// Write data files for the MCP server
		writeFileSync(join(tempDir, "chunks.json"), JSON.stringify(input.chunks));
		writeFileSync(join(tempDir, "concepts.json"), JSON.stringify(input.existingConcepts));

		// Convert relationship map to plain object for JSON serialization
		const relObj: Record<string, ExistingRelationship[]> = {};
		for (const [key, value] of input.existingRelationships) {
			relObj[key] = value;
		}
		writeFileSync(join(tempDir, "relationships.json"), JSON.stringify(relObj));

		// Write MCP server script
		const mcpScript = generateMcpServerScript(tempDir);
		const mcpScriptPath = join(tempDir, "extraction-mcp.js");
		writeFileSync(mcpScriptPath, mcpScript);

		// Write MCP config
		const mcpConfig = {
			mcpServers: {
				extractor: {
					type: "stdio",
					command: "node",
					args: [mcpScriptPath],
				},
			},
		};
		const mcpConfigPath = join(tempDir, "mcp-config.json");
		writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

		// Write system prompt
		const systemPrompt = buildAgentSystemPrompt(input, config);
		const systemPromptPath = join(tempDir, "system-prompt.txt");
		writeFileSync(systemPromptPath, systemPrompt);

		const args = [
			"--print",
			"--output-format",
			"text",
			"--model",
			model,
			"--mcp-config",
			mcpConfigPath,
			"--strict-mcp-config",
			"--dangerously-skip-permissions",
			"--max-turns",
			String(config.maxTurns),
			"--disallowedTools",
			...BLOCKED_BUILTIN_TOOLS,
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--append-system-prompt-file",
			systemPromptPath,
		];

		const userPrompt = `Analyze this ${input.resource.type} resource "${input.resource.name}" and extract its knowledge graph. Start by getting the material overview, then read and analyze the content according to your strategy. When done, call submit_extraction with your results.`;
		args.push(userPrompt);

		const resultPath = join(tempDir, "result.json");

		return await new Promise<ExtractionResult>((resolve, reject) => {
			const { PATH, HOME, SHELL, TERM } = process.env;
			const proc = spawn("claude", args, {
				cwd: tempDir,
				env: { PATH, HOME, SHELL, TERM },
				stdio: ["pipe", "pipe", "pipe"],
			});

			proc.stdin?.end();

			let stderr = "";
			let aborted = false;

			const onAbort = () => {
				aborted = true;
				proc.kill("SIGTERM");
				log.info(`runExtractionAgent — killing process for "${input.resource.name}" (cancelled)`);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				signal?.removeEventListener("abort", onAbort);

				if (aborted || signal?.aborted) {
					reject(new CancellationError("Extraction cancelled"));
					return;
				}

				if (code !== 0) {
					log.error(`runExtractionAgent — CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
					reject(new Error(`Extraction agent error (exit code ${code}): ${stderr.slice(0, 500)}`));
					return;
				}

				if (!existsSync(resultPath)) {
					reject(new Error("Agent did not call submit_extraction — no result.json produced"));
					return;
				}

				try {
					const raw = readFileSync(resultPath, "utf-8");
					const parsed = JSON.parse(raw) as ExtractionResult;
					log.info(
						`runExtractionAgent — "${input.resource.name}": ${parsed.concepts.length} concepts, ${parsed.file_concept_links.length + parsed.concept_concept_links.length + parsed.question_concept_links.length} relationships`,
					);
					resolve(parsed);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			proc.on("error", (err) => {
				signal?.removeEventListener("abort", onAbort);
				log.error(`runExtractionAgent — spawn error: ${err.message}`);
				reject(new Error(`Extraction agent spawn error: ${err.message}`));
			});
		});
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}
