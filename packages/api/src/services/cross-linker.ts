import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, getDb } from "@cramkit/shared";
import { BLOCKED_BUILTIN_TOOLS, LLM_MODEL, getCliModel } from "./llm-client.js";

const log = createLogger("api");

export interface CrossLinkResult {
	links: Array<{
		sourceConcept: string;
		targetConcept: string;
		relationship: string;
		confidence?: number;
	}>;
}

function generateCrossLinkerMcpScript(dataDir: string): string {
	return `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const dataDir = ${JSON.stringify(dataDir)};
const concepts = JSON.parse(fs.readFileSync(path.join(dataDir, "concepts.json"), "utf-8"));
const relationships = JSON.parse(fs.readFileSync(path.join(dataDir, "relationships.json"), "utf-8"));
const resources = JSON.parse(fs.readFileSync(path.join(dataDir, "resources.json"), "utf-8"));
const resourceConcepts = JSON.parse(fs.readFileSync(path.join(dataDir, "resource-concepts.json"), "utf-8"));
const resultPath = path.join(dataDir, "result.json");

const tools = [
  {
    name: "list_concepts",
    description: "List all concepts in the session with their descriptions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_concept_relationships",
    description: "Get all relationships for a specific concept.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Concept name" } },
      required: ["name"],
    },
  },
  {
    name: "list_resources",
    description: "List all indexed resources with their types and labels.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_resource_concepts",
    description: "Get all concepts linked to a specific resource.",
    inputSchema: {
      type: "object",
      properties: { resourceId: { type: "string", description: "Resource ID" } },
      required: ["resourceId"],
    },
  },
  {
    name: "submit_cross_links",
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
              relationship: { type: "string", enum: ["prerequisite", "related_to", "extends", "generalizes", "special_case_of", "contradicts"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
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
        serverInfo: { name: "cross-linker", version: "1.0.0" },
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
        case "list_concepts":
          content = concepts.length > 0
            ? concepts.map(c => c.name + (c.description ? ": " + c.description : "")).join("\\n")
            : "No concepts found.";
          break;
        case "get_concept_relationships": {
          const cName = args.name || "";
          const rels = relationships.filter(r =>
            r.sourceLabel === cName || r.targetLabel === cName
          );
          content = rels.length > 0
            ? rels.map(r => r.sourceLabel + " --[" + r.relationship + "]--> " + r.targetLabel + " (confidence: " + r.confidence + ")").join("\\n")
            : "No relationships found for: " + cName;
          break;
        }
        case "list_resources":
          content = resources.length > 0
            ? resources.map(r => r.id + " | " + r.type + " | " + r.name + (r.label ? " (" + r.label + ")" : "")).join("\\n")
            : "No resources found.";
          break;
        case "get_resource_concepts": {
          const rid = args.resourceId || "";
          const rc = resourceConcepts[rid] || [];
          content = rc.length > 0
            ? rc.map(c => c.name + " (" + c.relationship + ", confidence: " + c.confidence + ")").join("\\n")
            : "No concepts linked to resource: " + rid;
          break;
        }
        case "submit_cross_links": {
          fs.writeFileSync(resultPath, JSON.stringify(args, null, 2));
          content = "Cross-links submitted successfully.";
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

export async function runCrossLinkingAgent(sessionId: string): Promise<CrossLinkResult> {
	const db = getDb();
	const model = getCliModel(LLM_MODEL);

	// Gather all session data for the agent
	const [concepts, allRelationships, resources] = await Promise.all([
		db.concept.findMany({
			where: { sessionId },
			select: { name: true, description: true },
		}),
		db.relationship.findMany({
			where: { sessionId },
			select: {
				sourceType: true,
				sourceLabel: true,
				sourceId: true,
				targetType: true,
				targetLabel: true,
				targetId: true,
				relationship: true,
				confidence: true,
			},
		}),
		db.resource.findMany({
			where: { sessionId, isGraphIndexed: true },
			select: { id: true, name: true, type: true, label: true },
		}),
	]);

	if (concepts.length === 0) {
		log.info("runCrossLinkingAgent — no concepts to cross-link, skipping");
		return { links: [] };
	}

	// Build resource-concept map from relationships
	const resourceConcepts: Record<
		string,
		Array<{ name: string; relationship: string; confidence: number }>
	> = {};
	for (const rel of allRelationships) {
		if (rel.sourceType === "resource" && rel.targetType === "concept") {
			if (!resourceConcepts[rel.sourceId]) resourceConcepts[rel.sourceId] = [];
			resourceConcepts[rel.sourceId].push({
				name: rel.targetLabel ?? "",
				relationship: rel.relationship,
				confidence: rel.confidence,
			});
		}
		if (rel.sourceType === "chunk" && rel.targetType === "concept") {
			// Find which resource this chunk belongs to — use the resource list
			// For simplicity, also add to resource concepts via the source label
			for (const res of resources) {
				if (!resourceConcepts[res.id]) resourceConcepts[res.id] = [];
			}
		}
	}

	const tempDir = join(tmpdir(), `cramkit-crosslink-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	log.info(
		`runCrossLinkingAgent — session ${sessionId}: ${concepts.length} concepts, ${resources.length} resources`,
	);

	try {
		writeFileSync(join(tempDir, "concepts.json"), JSON.stringify(concepts));
		writeFileSync(join(tempDir, "relationships.json"), JSON.stringify(allRelationships));
		writeFileSync(join(tempDir, "resources.json"), JSON.stringify(resources));
		writeFileSync(join(tempDir, "resource-concepts.json"), JSON.stringify(resourceConcepts));

		const mcpScript = generateCrossLinkerMcpScript(tempDir);
		const mcpScriptPath = join(tempDir, "crosslink-mcp.js");
		writeFileSync(mcpScriptPath, mcpScript);

		const mcpConfig = {
			mcpServers: {
				crosslinker: {
					type: "stdio",
					command: "node",
					args: [mcpScriptPath],
				},
			},
		};
		const mcpConfigPath = join(tempDir, "mcp-config.json");
		writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

		const systemPrompt = `You are a knowledge graph cross-linking agent. Your job is to analyze the full knowledge graph of a study session and find missing connections between concepts from different resources.

Focus on:
- Exam questions that test lecture concepts (find concepts in past papers that match lecture note concepts)
- Problem sheet exercises that practice lecture topics
- Common concepts that appear across multiple resources but aren't yet linked
- Prerequisite relationships between concepts from different resources
- Concepts that generalize or extend other concepts

Do NOT create duplicate relationships that already exist.
Do NOT create trivial or low-confidence links.

Workflow:
1. List all resources to understand what material exists
2. List all concepts to see the full concept space
3. For key concepts, check their existing relationships to avoid duplicates
4. For each resource, check what concepts it covers
5. Identify missing cross-resource connections
6. Submit your new links via submit_cross_links

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
			"15",
			"--disallowedTools",
			...BLOCKED_BUILTIN_TOOLS,
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--append-system-prompt-file",
			systemPromptPath,
		];

		const userPrompt =
			"Analyze the knowledge graph for this study session and find missing cross-resource concept connections. Start by listing resources and concepts, then investigate relationships and submit new cross-links.";
		args.push(userPrompt);

		const resultPath = join(tempDir, "result.json");

		return await new Promise<CrossLinkResult>((resolve, reject) => {
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
					log.error(`runCrossLinkingAgent — CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
					reject(
						new Error(`Cross-linking agent error (exit code ${code}): ${stderr.slice(0, 500)}`),
					);
					return;
				}

				if (!existsSync(resultPath)) {
					log.info("runCrossLinkingAgent — agent did not submit links (no result.json)");
					resolve({ links: [] });
					return;
				}

				try {
					const raw = readFileSync(resultPath, "utf-8");
					const parsed = JSON.parse(raw) as CrossLinkResult;
					log.info(
						`runCrossLinkingAgent — session ${sessionId}: ${parsed.links.length} new cross-links`,
					);
					resolve(parsed);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			proc.on("error", (err) => {
				log.error(`runCrossLinkingAgent — spawn error: ${err.message}`);
				reject(new Error(`Cross-linking agent spawn error: ${err.message}`));
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
