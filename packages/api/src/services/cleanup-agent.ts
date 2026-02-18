import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, getDb } from "@cramkit/shared";
import { CancellationError } from "./errors.js";
import { deduplicateSessionRelationships } from "./graph-cleanup.js";
import { toTitleCase } from "./graph-indexer-utils.js";
import { BLOCKED_BUILTIN_TOOLS, LLM_MODEL, getCliModel } from "./llm-client.js";

const log = createLogger("api");

export interface CleanupAgentResult {
	merges: Array<{
		canonicalName: string;
		mergeNames: string[];
		mergedDescription?: string;
	}>;
	deleteConcepts: string[];
	deleteRelationships: string[];
	notes: string;
}

export interface CleanupAgentStats {
	conceptsMerged: number;
	conceptsDeleted: number;
	relationshipsDeleted: number;
	duplicatesAfterMerge: number;
}

function generateCleanupMcpScript(dataDir: string): string {
	return `#!/usr/bin/env node
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const dataDir = ${JSON.stringify(dataDir)};
const concepts = JSON.parse(fs.readFileSync(path.join(dataDir, "concepts.json"), "utf-8"));
const relationships = JSON.parse(fs.readFileSync(path.join(dataDir, "relationships.json"), "utf-8"));
const resultPath = path.join(dataDir, "result.json");

function diceCoefficient(a, b) {
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const bigrams1 = new Set();
  for (let i = 0; i < s1.length - 1; i++) bigrams1.add(s1.slice(i, i + 2));
  const bigrams2 = new Set();
  for (let i = 0; i < s2.length - 1; i++) bigrams2.add(s2.slice(i, i + 2));
  let intersection = 0;
  for (const b of bigrams1) { if (bigrams2.has(b)) intersection++; }
  return (2 * intersection) / (bigrams1.size + bigrams2.size);
}

const tools = [
  {
    name: "list_concepts",
    description: "List all concepts with descriptions, aliases, and relationship counts.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_similar_concepts",
    description: "Find concepts with names similar to the given name (using fuzzy matching).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Concept name to find similar matches for" },
        threshold: { type: "number", description: "Minimum similarity score (0-1, default 0.5)" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_concept_detail",
    description: "Get full details of a concept including all relationships involving it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Concept name" } },
      required: ["name"],
    },
  },
  {
    name: "get_relationship_stats",
    description: "Get aggregate statistics about relationships: totals, breakdown by type.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "preview_merge",
    description: "Preview what would happen if concepts were merged (which relationships would be redirected).",
    inputSchema: {
      type: "object",
      properties: {
        canonicalName: { type: "string", description: "The concept name to keep" },
        mergeNames: { type: "array", items: { type: "string" }, description: "Concept names to merge into the canonical" },
      },
      required: ["canonicalName", "mergeNames"],
    },
  },
  {
    name: "submit_cleanup",
    description: "Submit final cleanup decisions. Writes result.json with merge/delete operations.",
    inputSchema: {
      type: "object",
      properties: {
        merges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              canonicalName: { type: "string" },
              mergeNames: { type: "array", items: { type: "string" } },
              mergedDescription: { type: "string" },
            },
            required: ["canonicalName", "mergeNames"],
          },
        },
        deleteConcepts: { type: "array", items: { type: "string" }, description: "Concept names to delete entirely" },
        deleteRelationships: { type: "array", items: { type: "string" }, description: "Relationship IDs to delete" },
        notes: { type: "string", description: "Summary of cleanup actions taken" },
      },
      required: ["merges", "deleteConcepts", "deleteRelationships", "notes"],
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
        serverInfo: { name: "cleanup-agent", version: "1.0.0" },
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
        case "list_concepts": {
          const relCounts = {};
          for (const r of relationships) {
            if (r.sourceType === "concept") relCounts[r.sourceLabel] = (relCounts[r.sourceLabel] || 0) + 1;
            if (r.targetType === "concept") relCounts[r.targetLabel] = (relCounts[r.targetLabel] || 0) + 1;
          }
          content = concepts.map(c => {
            const count = relCounts[c.name] || 0;
            let line = c.name + " (" + count + " rels)";
            if (c.description) line += ": " + c.description;
            if (c.aliases) line += " [aliases: " + c.aliases + "]";
            return line;
          }).join("\\n");
          if (!content) content = "No concepts found.";
          break;
        }
        case "find_similar_concepts": {
          const threshold = args.threshold || 0.5;
          const matches = concepts
            .map(c => ({ name: c.name, score: diceCoefficient(args.name, c.name) }))
            .filter(m => m.score >= threshold && m.name.toLowerCase() !== args.name.toLowerCase())
            .sort((a, b) => b.score - a.score);
          content = matches.length > 0
            ? matches.map(m => m.name + " (similarity: " + m.score.toFixed(3) + ")").join("\\n")
            : "No similar concepts found above threshold " + threshold;
          break;
        }
        case "get_concept_detail": {
          const concept = concepts.find(c => c.name === args.name);
          if (!concept) { content = "Concept not found: " + args.name; break; }
          const rels = relationships.filter(r =>
            (r.sourceType === "concept" && r.sourceLabel === args.name) ||
            (r.targetType === "concept" && r.targetLabel === args.name)
          );
          let detail = "Name: " + concept.name + "\\n";
          if (concept.description) detail += "Description: " + concept.description + "\\n";
          if (concept.aliases) detail += "Aliases: " + concept.aliases + "\\n";
          detail += "\\nRelationships (" + rels.length + "):\\n";
          detail += rels.map(r => "  " + r.sourceLabel + " --[" + r.relationship + "]--> " + r.targetLabel + " (" + r.sourceType + "->" + r.targetType + ", confidence: " + r.confidence + ", id: " + r.id + ")").join("\\n");
          content = detail;
          break;
        }
        case "get_relationship_stats": {
          const byType = {};
          for (const r of relationships) {
            byType[r.relationship] = (byType[r.relationship] || 0) + 1;
          }
          const sourceTypes = {};
          for (const r of relationships) {
            const key = r.sourceType + "->" + r.targetType;
            sourceTypes[key] = (sourceTypes[key] || 0) + 1;
          }
          content = "Total relationships: " + relationships.length + "\\n\\nBy type:\\n";
          content += Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => "  " + k + ": " + v).join("\\n");
          content += "\\n\\nBy source->target type:\\n";
          content += Object.entries(sourceTypes).sort((a, b) => b[1] - a[1]).map(([k, v]) => "  " + k + ": " + v).join("\\n");
          break;
        }
        case "preview_merge": {
          const canonical = concepts.find(c => c.name === args.canonicalName);
          if (!canonical) { content = "Canonical concept not found: " + args.canonicalName; break; }
          const mergeTargets = (args.mergeNames || []).filter(n => concepts.find(c => c.name === n));
          const missing = (args.mergeNames || []).filter(n => !concepts.find(c => c.name === n));

          let preview = "Merge preview:\\n";
          preview += "  Keep: " + args.canonicalName + "\\n";
          preview += "  Merge: " + mergeTargets.join(", ") + "\\n";
          if (missing.length > 0) preview += "  Not found: " + missing.join(", ") + "\\n";

          const affectedRels = relationships.filter(r =>
            mergeTargets.some(n =>
              (r.sourceType === "concept" && r.sourceLabel === n) ||
              (r.targetType === "concept" && r.targetLabel === n)
            )
          );
          preview += "\\nRelationships to redirect: " + affectedRels.length + "\\n";
          for (const r of affectedRels) {
            preview += "  " + r.sourceLabel + " --[" + r.relationship + "]--> " + r.targetLabel + "\\n";
          }
          content = preview;
          break;
        }
        case "submit_cleanup": {
          fs.writeFileSync(resultPath, JSON.stringify(args, null, 2));
          content = "Cleanup decisions submitted successfully.";
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

export async function runCleanupAgent(
	sessionId: string,
	signal?: AbortSignal,
): Promise<CleanupAgentResult> {
	if (signal?.aborted) throw new CancellationError("Cleanup cancelled before start");
	const db = getDb();
	const model = getCliModel(LLM_MODEL);

	const [concepts, relationships] = await Promise.all([
		db.concept.findMany({
			where: { sessionId },
			select: { id: true, name: true, description: true, aliases: true },
		}),
		db.relationship.findMany({
			where: { sessionId },
			select: {
				id: true,
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

	if (concepts.length < 3) {
		log.info("runCleanupAgent — too few concepts to warrant cleanup, skipping");
		return {
			merges: [],
			deleteConcepts: [],
			deleteRelationships: [],
			notes: "Skipped: too few concepts",
		};
	}

	const tempDir = join(tmpdir(), `cramkit-cleanup-${randomUUID().slice(0, 8)}`);
	mkdirSync(tempDir, { recursive: true });

	log.info(
		`runCleanupAgent — session ${sessionId}: ${concepts.length} concepts, ${relationships.length} relationships`,
	);

	try {
		writeFileSync(join(tempDir, "concepts.json"), JSON.stringify(concepts));
		writeFileSync(join(tempDir, "relationships.json"), JSON.stringify(relationships));

		const mcpScript = generateCleanupMcpScript(tempDir);
		const mcpScriptPath = join(tempDir, "cleanup-mcp.js");
		writeFileSync(mcpScriptPath, mcpScript);

		const mcpConfig = {
			mcpServers: {
				cleanup: {
					type: "stdio",
					command: "node",
					args: [mcpScriptPath],
				},
			},
		};
		const mcpConfigPath = join(tempDir, "mcp-config.json");
		writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

		const systemPrompt = `You are a knowledge graph cleanup agent. Your job is to clean up a study session's knowledge graph by merging duplicate concepts and removing junk.

Your goals:
1. Find fuzzy duplicate concepts (e.g., "Fourier Transform" vs "Fourier Transforms", "ODE" vs "Ordinary Differential Equation")
2. Identify concepts that are aliases of each other but exist as separate entries
3. Remove concepts that are meaningless or too generic to be useful

Rules:
- Only merge concepts that genuinely refer to the SAME thing
- Do NOT merge related-but-distinct concepts (e.g., "Fourier Transform" and "Inverse Fourier Transform" are distinct)
- Prefer the more descriptive/formal name as the canonical name
- Use Title Case for canonical names
- If unsure, do NOT merge — false merges are worse than duplicates
- Be conservative: it's better to leave minor duplicates than to incorrectly merge distinct concepts

Workflow:
1. List all concepts to see the full set
2. Use find_similar_concepts to find potential duplicates (try several key concepts)
3. For promising matches, use get_concept_detail to compare their relationships
4. Use preview_merge to verify merge decisions look correct
5. Submit your final cleanup decisions via submit_cleanup

If the graph looks clean with no obvious duplicates, submit an empty cleanup with a note saying so.`;

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
			"12",
			"--disallowedTools",
			...BLOCKED_BUILTIN_TOOLS,
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--append-system-prompt-file",
			systemPromptPath,
		];

		const userPrompt =
			"Clean up the knowledge graph for this study session. Find and merge duplicate concepts, and remove any junk. Start by listing concepts and finding similar names.";
		args.push(userPrompt);

		const resultPath = join(tempDir, "result.json");

		return await new Promise<CleanupAgentResult>((resolve, reject) => {
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

			const onAbort = () => {
				aborted = true;
				proc.kill("SIGTERM");
				log.info(`runCleanupAgent — killing process for session ${sessionId} (cancelled)`);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				signal?.removeEventListener("abort", onAbort);

				if (aborted || signal?.aborted) {
					reject(new CancellationError("Cleanup cancelled"));
					return;
				}

				if (code !== 0) {
					const output = (stderr || stdout).slice(0, 500);
					log.error(`runCleanupAgent — CLI exited with code ${code}: ${output}`);
					reject(new Error(`Cleanup agent error (exit code ${code}): ${output}`));
					return;
				}

				if (!existsSync(resultPath)) {
					log.info("runCleanupAgent — agent did not submit decisions (no result.json)");
					resolve({
						merges: [],
						deleteConcepts: [],
						deleteRelationships: [],
						notes: "Agent did not submit cleanup decisions",
					});
					return;
				}

				try {
					const raw = readFileSync(resultPath, "utf-8");
					const parsed = JSON.parse(raw) as CleanupAgentResult;
					log.info(
						`runCleanupAgent — session ${sessionId}: ${parsed.merges.length} merges, ${parsed.deleteConcepts.length} deletes`,
					);
					resolve(parsed);
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			proc.on("error", (err) => {
				signal?.removeEventListener("abort", onAbort);
				log.error(`runCleanupAgent — spawn error: ${err.message}`);
				reject(new Error(`Cleanup agent spawn error: ${err.message}`));
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

export async function applyCleanupResult(
	sessionId: string,
	result: CleanupAgentResult,
): Promise<CleanupAgentStats> {
	const db = getDb();

	const stats: CleanupAgentStats = {
		conceptsMerged: 0,
		conceptsDeleted: 0,
		relationshipsDeleted: 0,
		duplicatesAfterMerge: 0,
	};

	const totalOps =
		result.merges.length + result.deleteConcepts.length + result.deleteRelationships.length;
	if (totalOps === 0) {
		log.info(`applyCleanupResult — session ${sessionId}: nothing to apply`);
		return stats;
	}

	await db.$transaction(
		async (tx) => {
			// 1. Process merges
			for (const merge of result.merges) {
				const canonicalName = toTitleCase(merge.canonicalName);
				const canonical = await tx.concept.findUnique({
					where: { sessionId_name: { sessionId, name: canonicalName } },
				});
				if (!canonical) {
					log.warn(`applyCleanupResult — canonical concept not found: ${canonicalName}`);
					continue;
				}

				for (const mergeName of merge.mergeNames) {
					const mergeNameTC = toTitleCase(mergeName);
					const mergeConcept = await tx.concept.findUnique({
						where: { sessionId_name: { sessionId, name: mergeNameTC } },
					});
					if (!mergeConcept) continue;

					// Redirect relationships from merge target to canonical
					await tx.relationship.updateMany({
						where: { sessionId, sourceType: "concept", sourceId: mergeConcept.id },
						data: { sourceId: canonical.id, sourceLabel: canonicalName },
					});
					await tx.relationship.updateMany({
						where: { sessionId, targetType: "concept", targetId: mergeConcept.id },
						data: { targetId: canonical.id, targetLabel: canonicalName },
					});

					// Append alias
					const existingAliases = canonical.aliases ? canonical.aliases.split(", ") : [];
					if (!existingAliases.includes(mergeNameTC)) {
						existingAliases.push(mergeNameTC);
					}

					await tx.concept.update({
						where: { id: canonical.id },
						data: {
							aliases: existingAliases.join(", "),
							...(merge.mergedDescription ? { description: merge.mergedDescription } : {}),
						},
					});

					// Delete the merge target concept
					await tx.concept.delete({ where: { id: mergeConcept.id } });
					stats.conceptsMerged++;
				}
			}

			// 2. Delete flagged concepts
			for (const conceptName of result.deleteConcepts) {
				const name = toTitleCase(conceptName);
				const concept = await tx.concept.findUnique({
					where: { sessionId_name: { sessionId, name } },
				});
				if (!concept) continue;

				// Delete relationships involving this concept
				await tx.relationship.deleteMany({
					where: {
						sessionId,
						OR: [
							{ sourceType: "concept", sourceId: concept.id },
							{ targetType: "concept", targetId: concept.id },
						],
					},
				});
				await tx.concept.delete({ where: { id: concept.id } });
				stats.conceptsDeleted++;
			}

			// 3. Delete flagged relationships
			if (result.deleteRelationships.length > 0) {
				const deleteResult = await tx.relationship.deleteMany({
					where: { id: { in: result.deleteRelationships }, sessionId },
				});
				stats.relationshipsDeleted = deleteResult.count;
			}

			// 4. Re-deduplicate (merging can create new duplicates)
			stats.duplicatesAfterMerge = await deduplicateSessionRelationships(tx, sessionId);
		},
		{ timeout: 30000 },
	);

	log.info(
		`applyCleanupResult — session ${sessionId}: merged ${stats.conceptsMerged} concepts, deleted ${stats.conceptsDeleted} concepts, deleted ${stats.relationshipsDeleted} relationships, removed ${stats.duplicatesAfterMerge} post-merge duplicates`,
	);

	return stats;
}
