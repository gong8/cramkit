import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@cramkit/shared";
import type { IndexerLogger } from "../lib/indexer-logger.js";
import { CancellationError } from "./errors.js";
import { BLOCKED_BUILTIN_TOOLS, LLM_MODEL, getCliModel } from "./llm-client.js";

const log = createLogger("api");

interface FileData {
	filename: string;
	role: string;
	content: string;
}

interface ChunkData {
	id: string;
	title: string | null;
	content: string;
	depth: number;
	nodeType: string;
	parentId: string | null;
}

interface ExistingConcept {
	id: string;
	name: string;
	description: string | null;
}

export interface MetadataAgentInput {
	resource: { name: string; type: string; label: string | null };
	files: FileData[];
	chunks: ChunkData[];
	existingConcepts: ExistingConcept[];
}

export interface MetadataExtractionResult {
	questions?: Array<{
		questionNumber: string;
		parentNumber?: string;
		marks?: number;
		questionType?: string;
		commandWords?: string;
		content: string;
		markSchemeText?: string;
		solutionText?: string;
		chunkTitle?: string;
		conceptLinks?: Array<{
			conceptName: string;
			relationship: string;
			confidence?: number;
		}>;
		metadata?: Record<string, unknown>;
	}>;
	conceptUpdates?: Array<{
		name: string;
		content?: string;
		contentType?: string;
		metadata?: Record<string, unknown>;
	}>;
	resourceMetadata?: Record<string, unknown>;
	chunkMetadata?: Array<{
		chunkTitle: string;
		metadata: Record<string, unknown>;
	}>;
}

function generateMcpServerScript(dataDir: string): string {
	return `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const dataDir = ${JSON.stringify(dataDir)};
const chunks = JSON.parse(fs.readFileSync(path.join(dataDir, "chunks.json"), "utf-8"));
const concepts = JSON.parse(fs.readFileSync(path.join(dataDir, "concepts.json"), "utf-8"));
const files = JSON.parse(fs.readFileSync(path.join(dataDir, "files.json"), "utf-8"));
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
    description: "Get resource name, type, file list with roles, and hierarchical table of contents of the material.",
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
    name: "read_file_by_role",
    description: "Return all content from files with a specific role (PRIMARY, MARK_SCHEME, SOLUTIONS, SUPPLEMENT). Use this to cross-reference mark schemes and solutions with questions.",
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", enum: ["PRIMARY", "MARK_SCHEME", "SOLUTIONS", "SUPPLEMENT"], description: "File role to read" } },
      required: ["role"],
    },
  },
  {
    name: "search_content",
    description: "Search across all chunks for a substring. Returns matching snippets with context.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Substring to search for" } },
      required: ["query"],
    },
  },
  {
    name: "get_existing_concepts",
    description: "List concepts already extracted from this session. Optionally filter by name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional name filter (substring match)" } },
      required: [],
    },
  },
  {
    name: "submit_metadata",
    description: "Submit the final metadata extraction result. Call this exactly once when done. Include questions, concept content updates, resource metadata, and chunk metadata.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              questionNumber: { type: "string", description: "Question number as it appears, e.g. '1', '2a', '3(b)(ii)'" },
              parentNumber: { type: "string", description: "Parent question number, e.g. '2' for part '2a'" },
              marks: { type: "integer", description: "Mark allocation for this question" },
              questionType: { type: "string", description: "Type: calculation, proof, essay, short_answer, define_and_explain, etc." },
              commandWords: { type: "string", description: "Comma-separated command words: state,prove,calculate,etc." },
              content: { type: "string", description: "Verbatim question text" },
              markSchemeText: { type: "string", description: "Verbatim mark scheme text for this question" },
              solutionText: { type: "string", description: "Verbatim solution/worked example text" },
              chunkTitle: { type: "string", description: "Section title this question appears in" },
              conceptLinks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    conceptName: { type: "string" },
                    relationship: { type: "string", enum: ["tests", "requires", "applies"] },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                  },
                  required: ["conceptName", "relationship"],
                },
              },
              metadata: { type: "object", description: "Freeform metadata (examiner notes, difficulty, etc.)" },
            },
            required: ["questionNumber", "content"],
          },
        },
        conceptUpdates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Must match an existing concept name exactly" },
              content: { type: "string", description: "Verbatim definition, theorem statement, or formula" },
              contentType: { type: "string", enum: ["definition", "theorem", "formula", "worked_example", "lemma", "algorithm"] },
              metadata: { type: "object", description: "Freeform metadata" },
            },
            required: ["name"],
          },
        },
        resourceMetadata: { type: "object", description: "Resource-level metadata (year, total marks, duration, rubric, etc.)" },
        chunkMetadata: {
          type: "array",
          items: {
            type: "object",
            properties: {
              chunkTitle: { type: "string", description: "Section title to attach metadata to" },
              metadata: { type: "object", description: "Metadata for this section" },
            },
            required: ["chunkTitle", "metadata"],
          },
        },
      },
      required: [],
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
        serverInfo: { name: "metadata-agent", version: "1.0.0" },
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
          const resourceInfo = JSON.parse(fs.readFileSync(path.join(dataDir, "resource-info.json"), "utf-8"));
          const lines = [];
          lines.push("Resource: " + resourceInfo.name);
          lines.push("Type: " + resourceInfo.type);
          if (resourceInfo.label) lines.push("Label: " + resourceInfo.label);
          lines.push("");
          lines.push("Files:");
          for (const f of files) {
            lines.push("  - " + f.filename + " (" + f.role + ", " + f.content.length + " chars)");
          }
          lines.push("");
          lines.push("Sections:");
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
        case "read_file_by_role": {
          const role = args.role || "";
          const matching = files.filter(f => f.role === role);
          if (matching.length === 0) {
            content = "No files found with role: " + role;
          } else {
            content = matching.map(f => "=== " + f.filename + " (" + f.role + ") ===\\n\\n" + f.content).join("\\n\\n");
          }
          break;
        }
        case "search_content": {
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
        case "submit_metadata": {
          fs.writeFileSync(resultPath, JSON.stringify(args, null, 2));
          content = "Metadata submitted successfully.";
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

const RESOURCE_TYPE_PROMPTS: Record<string, string> = {
	PAST_PAPER: `You are extracting structured metadata from a past exam paper.

## Primary Task: Extract Every Question
For EACH question in the paper:
1. Extract the question number exactly as it appears (e.g. "1", "2a", "3(b)(ii)")
2. Set parentNumber for sub-questions (e.g. parentNumber="2" for "2a")
3. Extract the mark allocation if shown
4. Identify the question type: calculation, proof, essay, short_answer, define_and_explain, multiple_choice, etc.
5. Extract command words: state, prove, calculate, show, explain, derive, sketch, etc.
6. Copy the VERBATIM question text into content

## Cross-Reference with Mark Scheme
If a MARK_SCHEME file exists:
1. Use read_file_by_role with role "MARK_SCHEME" to read it
2. Match each mark scheme entry to its question by question number
3. Copy the VERBATIM mark scheme text into markSchemeText
4. Note any common mistakes, examiner notes, or mark breakdowns in metadata

## Cross-Reference with Solutions
If a SOLUTIONS file exists:
1. Use read_file_by_role with role "SOLUTIONS" to read it
2. Match solutions to questions
3. Copy the VERBATIM worked solution into solutionText

## Concept Links
For each question, identify which concepts it tests, requires, or applies:
- "tests": The question directly examines understanding of this concept (it is the focus of the question)
- "requires": The concept is a prerequisite needed to attempt the question, but is not the focus
- "applies": The question uses this concept as a tool or technique to solve a different problem

## Resource Metadata
Extract paper-level metadata: year, exam board, total marks, duration, rubric instructions, etc.`,

	LECTURE_NOTES: `You are extracting structured metadata from lecture notes.

## Primary Task: Extract Verbatim Content for Concepts
For every concept that has been identified in this session:
1. Find its definition, theorem statement, formula, or algorithm in the material
2. Copy the EXACT verbatim text into a concept update
3. Set the contentType: definition, theorem, formula, worked_example, lemma, algorithm
4. Add any relevant metadata (proof outline, derivation context, prerequisites)
5. Look for prerequisite chains: when the material says "recall that X" or "using Y from earlier",
   note these dependencies in metadata so the knowledge graph can capture learning order

## Section Metadata
For each major section, identify:
- Learning objectives
- Prerequisites assumed (concepts that must be understood before this section)
- Topic weightings (if mentioned)
- Key formulas or results
- Prerequisite chains between concepts defined in this section`,

	SPECIFICATION: `You are extracting structured metadata from a course specification.

## Primary Task: Extract Verbatim Content for Concepts
For every concept mentioned in the specification:
1. Find its official definition or description
2. Copy the EXACT verbatim text into a concept update
3. Set contentType accordingly
4. Add metadata about assessment weighting, learning outcomes, etc.

## Resource Metadata
Extract: module code, credit value, assessment structure, topic weightings, learning outcomes.`,

	PROBLEM_SHEET: `You are extracting structured metadata from a problem sheet.

## Primary Task: Extract Every Question
For EACH problem/exercise:
1. Extract the question number as it appears
2. Extract marks if given
3. Identify the question type and difficulty
4. Copy the VERBATIM question text

## Cross-Reference with Solutions
If a SOLUTIONS file exists, read it and match solutions to problems.

## Concept Links
For each question, identify which concepts it tests, requires, or applies:
- "tests": The question directly examines understanding of this concept (it is the focus of the question)
- "requires": The concept is a prerequisite needed to attempt the question, but is not the focus
- "applies": The question uses this concept as a tool or technique to solve a different problem`,

	OTHER: `You are extracting structured metadata from study material.

## Tasks
1. Extract any questions with their text, marks, and types
2. Extract verbatim definitions, theorems, and formulas for existing concepts
3. Add resource-level and section-level metadata as appropriate`,
};

function buildAgentSystemPrompt(input: MetadataAgentInput): string {
	const typePrompt = RESOURCE_TYPE_PROMPTS[input.resource.type] || RESOURCE_TYPE_PROMPTS.OTHER;
	const fileList = input.files.map((f) => `  - ${f.filename} (${f.role})`).join("\n");
	const hasMarkScheme = input.files.some((f) => f.role === "MARK_SCHEME");
	const hasSolutions = input.files.some((f) => f.role === "SOLUTIONS");

	return `${typePrompt}

## Resource Info
Name: ${input.resource.name}
Type: ${input.resource.type}${input.resource.label ? `\nLabel: ${input.resource.label}` : ""}
Files:
${fileList}
${hasMarkScheme ? "\nA MARK_SCHEME file is available — you MUST cross-reference it." : ""}
${hasSolutions ? "\nA SOLUTIONS file is available — you MUST cross-reference it." : ""}

## Workflow
1. Call get_material_overview to see the structure
2. Read sections systematically using read_section
3. If MARK_SCHEME or SOLUTIONS files exist, read them with read_file_by_role
4. Check existing concepts with get_existing_concepts
5. Call submit_metadata ONCE with your complete result

## Rules
- Copy text VERBATIM — do not paraphrase definitions, theorems, or question text
- Use exact concept names from get_existing_concepts when updating concepts
- The metadata fields are freeform JSON — include whatever is relevant
- You MUST call submit_metadata before finishing — this is how your work is saved
- Include conceptLinks on questions to connect them to the knowledge graph

## Confidence Guidance for Concept Links
- 0.9+: The question explicitly names or defines the concept
- 0.7-0.89: The concept is strongly implied by the question content
- 0.5-0.69: The concept is tangentially involved
- Below 0.5: Do not create the link`;
}

export async function runMetadataAgent(
	input: MetadataAgentInput,
	signal?: AbortSignal,
	indexerLog?: IndexerLogger,
): Promise<MetadataExtractionResult> {
	if (signal?.aborted) throw new CancellationError("Metadata extraction cancelled before start");

	const model = getCliModel(LLM_MODEL);
	const maxTurns = 20;

	const tempDir = join(tmpdir(), `cramkit-meta-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	log.info(`runMetadataAgent — "${input.resource.name}" [${input.resource.type}]`);

	try {
		// Write data files for the MCP server
		writeFileSync(join(tempDir, "chunks.json"), JSON.stringify(input.chunks));
		writeFileSync(join(tempDir, "concepts.json"), JSON.stringify(input.existingConcepts));
		writeFileSync(join(tempDir, "files.json"), JSON.stringify(input.files));
		writeFileSync(join(tempDir, "resource-info.json"), JSON.stringify(input.resource));

		// Write MCP server script
		const mcpScript = generateMcpServerScript(tempDir);
		const mcpScriptPath = join(tempDir, "metadata-mcp.js");
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
		const systemPrompt = buildAgentSystemPrompt(input);
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
			String(maxTurns),
			"--disallowedTools",
			...BLOCKED_BUILTIN_TOOLS,
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--append-system-prompt-file",
			systemPromptPath,
		];

		const userPrompt = `Extract structured metadata from this ${input.resource.type} resource "${input.resource.name}". Start by getting the material overview, then systematically read and extract content. When done, call submit_metadata with your results.`;
		args.push(userPrompt);

		const resultPath = join(tempDir, "result.json");

		const activeLog = indexerLog ?? log;
		activeLog.info(`runMetadataAgent — CLI args: claude ${args.join(" ")}`);

		return await new Promise<MetadataExtractionResult>((resolve, reject) => {
			const { PATH, HOME, SHELL, TERM } = process.env;
			const proc = spawn("claude", args, {
				cwd: tempDir,
				env: { PATH, HOME, SHELL, TERM },
				stdio: ["pipe", "pipe", "pipe"],
			});

			proc.stdin?.end();

			let stdout = "";
			let stderr = "";
			let aborted = false;

			const agentPaths = indexerLog?.getAgentLogPaths("metadata", input.resource.name);
			const stdoutFile = agentPaths ? createWriteStream(agentPaths.stdoutPath) : null;
			const stderrFile = agentPaths ? createWriteStream(agentPaths.stderrPath) : null;

			const onAbort = () => {
				aborted = true;
				proc.kill("SIGTERM");
				activeLog.info(
					`runMetadataAgent — killing process for "${input.resource.name}" (cancelled)`,
				);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				stdoutFile?.write(chunk);
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				stderrFile?.write(chunk);
			});

			proc.on("close", (code) => {
				signal?.removeEventListener("abort", onAbort);
				stdoutFile?.end();
				stderrFile?.end();

				if (aborted || signal?.aborted) {
					reject(new CancellationError("Metadata extraction cancelled"));
					return;
				}

				if (code !== 0) {
					const output = (stderr || stdout).slice(0, 500);
					activeLog.error(`runMetadataAgent — CLI exited with code ${code}: ${output}`);
					if (indexerLog) {
						indexerLog.error(`runMetadataAgent — FULL stderr (${stderr.length} chars):\n${stderr}`);
						indexerLog.error(`runMetadataAgent — FULL stdout (${stdout.length} chars):\n${stdout}`);
					}
					reject(new Error(`Metadata agent error (exit code ${code}): ${output}`));
					return;
				}

				if (!existsSync(resultPath)) {
					reject(new Error("Agent did not call submit_metadata — no result.json produced"));
					return;
				}

				try {
					const raw = readFileSync(resultPath, "utf-8");
					const parsed = JSON.parse(raw) as MetadataExtractionResult;
					activeLog.info(
						`runMetadataAgent — "${input.resource.name}": ${parsed.questions?.length ?? 0} questions, ${parsed.conceptUpdates?.length ?? 0} concept updates`,
					);
					resolve(parsed);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			proc.on("error", (err) => {
				signal?.removeEventListener("abort", onAbort);
				stdoutFile?.end();
				stderrFile?.end();
				activeLog.error(`runMetadataAgent — spawn error: ${err.message}`);
				reject(new Error(`Metadata agent spawn error: ${err.message}`));
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
