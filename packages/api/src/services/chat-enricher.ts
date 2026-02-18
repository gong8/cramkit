import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, getDb } from "@cramkit/shared";
import { BLOCKED_BUILTIN_TOOLS, LLM_MODEL, getCliModel } from "./llm-client.js";

const log = createLogger("api");

export interface EnrichmentInput {
	sessionId: string;
	conversationId: string;
	accessedEntities: Array<{ type: string; id: string }>;
}

export interface EnrichmentResult {
	links: Array<{
		sourceConcept: string;
		targetConcept: string;
		relationship: string;
		confidence?: number;
	}>;
}

function generateEnricherMcpScript(dataDir: string): string {
	return `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const dataDir = ${JSON.stringify(dataDir)};
const entities = JSON.parse(fs.readFileSync(path.join(dataDir, "entities.json"), "utf-8"));
const relationships = JSON.parse(fs.readFileSync(path.join(dataDir, "relationships.json"), "utf-8"));
const allConcepts = JSON.parse(fs.readFileSync(path.join(dataDir, "all-concepts.json"), "utf-8"));
const resultPath = path.join(dataDir, "result.json");

const tools = [
  {
    name: "get_accessed_entities",
    description: "Get the entities that were accessed during this chat turn, with their names, descriptions, and types.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_entity_relationships",
    description: "Get all existing relationships for a specific entity.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entity ID" },
        type: { type: "string", description: "Entity type: concept, chunk, or resource" },
      },
      required: ["id", "type"],
    },
  },
  {
    name: "list_session_concepts",
    description: "List all concepts in the session to discover potential missing links.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "submit_links",
    description: "Submit new concept-concept relationships to add to the knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sourceConcept: { type: "string" },
              targetConcept: { type: "string" },
              relationship: {
                type: "string",
                enum: ["prerequisite", "related_to", "extends", "generalizes", "special_case_of", "contradicts"],
                description: "prerequisite: source must be understood before target. extends: source builds upon target with additional structure. generalizes: source is a broader framework containing target. special_case_of: source is a specific instance of target. contradicts: source conflicts with target. related_to: LAST RESORT when no specific type fits.",
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
                description: "0.9+: explicitly evident from context. 0.7-0.89: strong inference. 0.5-0.69: moderate connection. Do not create links below 0.5.",
              },
            },
            required: ["sourceConcept", "targetConcept", "relationship"],
          },
        },
      },
      required: ["links"],
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
        serverInfo: { name: "chat-enricher", version: "1.0.0" },
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
        case "get_accessed_entities":
          content = entities.length > 0
            ? JSON.stringify(entities, null, 2)
            : "No entities were accessed.";
          break;
        case "get_entity_relationships": {
          const eId = args.id || "";
          const eType = args.type || "";
          const rels = relationships.filter(r =>
            (r.sourceType === eType && r.sourceId === eId) ||
            (r.targetType === eType && r.targetId === eId)
          );
          content = rels.length > 0
            ? rels.map(r => r.sourceLabel + " --[" + r.relationship + "]--> " + r.targetLabel + " (confidence: " + r.confidence + ")").join("\\n")
            : "No relationships found for " + eType + " " + eId;
          break;
        }
        case "list_session_concepts":
          content = allConcepts.length > 0
            ? allConcepts.map(c => c.name + (c.description ? ": " + c.description : "")).join("\\n")
            : "No concepts found.";
          break;
        case "submit_links": {
          fs.writeFileSync(resultPath, JSON.stringify(args, null, 2));
          content = "Links submitted successfully.";
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

export async function runChatEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
	const db = getDb();
	const model = getCliModel(LLM_MODEL);

	// Fetch entity details from DB
	const conceptIds = input.accessedEntities.filter((e) => e.type === "concept").map((e) => e.id);
	const chunkIds = input.accessedEntities.filter((e) => e.type === "chunk").map((e) => e.id);
	const resourceIds = input.accessedEntities.filter((e) => e.type === "resource").map((e) => e.id);

	const [concepts, chunks, resources, allConcepts, allRelationships] = await Promise.all([
		conceptIds.length > 0
			? db.concept.findMany({
					where: { id: { in: conceptIds } },
					select: { id: true, name: true, description: true },
				})
			: [],
		chunkIds.length > 0
			? db.chunk.findMany({
					where: { id: { in: chunkIds } },
					select: { id: true, title: true, resourceId: true },
				})
			: [],
		resourceIds.length > 0
			? db.resource.findMany({
					where: { id: { in: resourceIds } },
					select: { id: true, name: true, type: true },
				})
			: [],
		db.concept.findMany({
			where: { sessionId: input.sessionId },
			select: { id: true, name: true, description: true },
		}),
		db.relationship.findMany({
			where: { sessionId: input.sessionId },
			select: {
				sourceType: true,
				sourceId: true,
				sourceLabel: true,
				targetType: true,
				targetId: true,
				targetLabel: true,
				relationship: true,
				confidence: true,
			},
		}),
	]);

	// Build enriched entity list
	const entities = [
		...concepts.map((c) => ({
			type: "concept",
			id: c.id,
			name: c.name,
			description: c.description,
		})),
		...chunks.map((c) => ({
			type: "chunk",
			id: c.id,
			name: c.title ?? "Untitled chunk",
			resourceId: c.resourceId,
		})),
		...resources.map((r) => ({ type: "resource", id: r.id, name: r.name, resourceType: r.type })),
	];

	if (entities.length < 2) {
		log.info("runChatEnrichment — fewer than 2 resolved entities, skipping");
		return { links: [] };
	}

	const tempDir = join(tmpdir(), `cramkit-enricher-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	log.info(
		`runChatEnrichment — session ${input.sessionId}, conversation ${input.conversationId}: ${entities.length} entities`,
	);

	try {
		writeFileSync(join(tempDir, "entities.json"), JSON.stringify(entities));
		writeFileSync(join(tempDir, "relationships.json"), JSON.stringify(allRelationships));
		writeFileSync(join(tempDir, "all-concepts.json"), JSON.stringify(allConcepts));

		const mcpScript = generateEnricherMcpScript(tempDir);
		const mcpScriptPath = join(tempDir, "enricher-mcp.js");
		writeFileSync(mcpScriptPath, mcpScript);

		const mcpConfig = {
			mcpServers: {
				enricher: {
					type: "stdio",
					command: "node",
					args: [mcpScriptPath],
				},
			},
		};
		const mcpConfigPath = join(tempDir, "mcp-config.json");
		writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

		const systemPrompt = `You are a knowledge graph enrichment agent. These entities were accessed together during a study chat session. Analyze what relationships should exist between them that are currently missing from the graph.

Focus on:
- Prerequisite chains between concepts (A must be understood before B)
- Extension/generalization relationships (A extends or generalizes B)
- Special case relationships (A is a specific instance of B)
- Concept-to-concept links — choose the most specific type:
  * "prerequisite": Clear learning dependency (source must be understood before target)
  * "extends": Source builds upon target with additional structure
  * "generalizes": Source is a broader framework containing target
  * "special_case_of": Source is a specific instance of target
  * "related_to": LAST RESORT — only when no specific type fits
- Connections revealed by the fact that these entities were accessed together

Confidence guidance:
- 0.9+: Explicitly evident from the conversation context
- 0.7-0.89: Strong inference from content
- 0.5-0.69: Moderate connection
- Below 0.5: Do not create

Do NOT create duplicate relationships that already exist.
Do NOT create trivial or low-confidence links.

Workflow:
1. Get the accessed entities to understand what was used together
2. Check existing relationships for those entities
3. List all session concepts to find missing connections
4. Submit new links via submit_links

Use Title Case for all concept names. Match existing concept names exactly.`;

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
			"5",
			"--disallowedTools",
			...BLOCKED_BUILTIN_TOOLS,
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--append-system-prompt-file",
			systemPromptPath,
		];

		const userPrompt =
			"Analyze the entities accessed during this chat turn and identify missing knowledge graph relationships. Start by getting the accessed entities, then check their relationships, and submit any new links.";
		args.push(userPrompt);

		const resultPath = join(tempDir, "result.json");

		return await new Promise<EnrichmentResult>((resolve, reject) => {
			const { PATH, HOME, SHELL, TERM } = process.env;
			const proc = spawn("claude", args, {
				cwd: tempDir,
				env: { PATH, HOME, SHELL, TERM },
				stdio: ["pipe", "pipe", "pipe"],
			});

			proc.stdin?.end();

			let stderr = "";

			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (code !== 0) {
					log.error(`runChatEnrichment — CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
					reject(
						new Error(`Chat enrichment agent error (exit code ${code}): ${stderr.slice(0, 500)}`),
					);
					return;
				}

				if (!existsSync(resultPath)) {
					log.info("runChatEnrichment — agent did not submit links (no result.json)");
					resolve({ links: [] });
					return;
				}

				try {
					const raw = readFileSync(resultPath, "utf-8");
					const parsed = JSON.parse(raw) as EnrichmentResult;
					log.info(
						`runChatEnrichment — conversation ${input.conversationId}: ${parsed.links.length} new links`,
					);
					resolve(parsed);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			proc.on("error", (err) => {
				log.error(`runChatEnrichment — spawn error: ${err.message}`);
				reject(new Error(`Chat enrichment agent spawn error: ${err.message}`));
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
