import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createLogger, getDb } from "@cramkit/shared";
import type { ExportManifest, ResourceExport } from "@cramkit/shared";
import archiver from "archiver";
import { getResourceDir } from "./storage.js";

const log = createLogger("export");

interface ConceptExport {
	id: string;
	name: string;
	description: string | null;
	aliases: string | null;
	createdBy: string;
}

interface RelationshipExport {
	id: string;
	sourceType: string;
	sourceId: string;
	sourceLabel: string | null;
	targetType: string;
	targetId: string;
	targetLabel: string | null;
	relationship: string;
	confidence: number;
	createdBy: string;
}

interface ConversationExport {
	id: string;
	title: string;
	messages: Array<{
		id: string;
		role: string;
		content: string;
		toolCalls?: string | null;
		attachments?: Array<{
			id: string;
			filename: string;
			contentType: string;
			fileSize: number;
		}>;
	}>;
}

/**
 * Export a session as a zip archive buffer.
 * Includes all resources (files, chunks, tree), concepts, relationships,
 * conversations (messages + attachments), and a human-readable README.
 */
export async function exportSession(sessionId: string): Promise<Buffer> {
	const db = getDb();

	// 1. Query session with ALL related data
	const session = await db.session.findUnique({
		where: { id: sessionId },
		include: {
			resources: {
				include: {
					files: true,
					chunks: { orderBy: { index: "asc" } },
				},
			},
			concepts: true,
			relationships: true,
			conversations: {
				include: {
					messages: {
						orderBy: { createdAt: "asc" },
						include: { attachments: true },
					},
				},
			},
		},
	});

	if (!session) {
		throw new Error(`Session ${sessionId} not found`);
	}

	log.info(`exportSession — exporting "${session.name}" (${sessionId})`);

	// 2. Compute stats
	const fileCount = session.resources.reduce((sum, r) => sum + r.files.length, 0);
	const chunkCount = session.resources.reduce((sum, r) => sum + r.chunks.length, 0);
	const messageCount = session.conversations.reduce((sum, c) => sum + c.messages.length, 0);

	// 3. Build manifest
	const manifest: ExportManifest = {
		version: 1,
		exportedAt: new Date().toISOString(),
		session: {
			name: session.name,
			module: session.module,
			examDate: session.examDate?.toISOString() ?? null,
			scope: session.scope,
			notes: session.notes,
		},
		resourceIds: session.resources.map((r) => r.id),
		conversationIds: session.conversations.map((c) => c.id),
		stats: {
			resourceCount: session.resources.length,
			fileCount,
			chunkCount,
			conceptCount: session.concepts.length,
			relationshipCount: session.relationships.length,
			conversationCount: session.conversations.length,
			messageCount,
		},
	};

	// 4. Create zip archive
	const archive = archiver("zip", { zlib: { level: 6 } });
	const chunks: Buffer[] = [];

	archive.on("data", (chunk: Buffer) => chunks.push(chunk));
	archive.on("warning", (err) => log.warn(`archiver warning: ${err.message}`));
	archive.on("error", (err) => {
		throw err;
	});

	// manifest.json
	archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

	// 5. Resources
	for (const resource of session.resources) {
		const resourcePrefix = `resources/${resource.id}`;
		const resourceDir = getResourceDir(sessionId, resource.id);

		// Build resource.json with relativized paths
		const resourceExport: ResourceExport = {
			id: resource.id,
			name: resource.name,
			type: resource.type as ResourceExport["type"],
			label: resource.label,
			splitMode: resource.splitMode,
			isIndexed: resource.isIndexed,
			isGraphIndexed: resource.isGraphIndexed,
			files: resource.files.map((f) => ({
				id: f.id,
				filename: f.filename,
				role: f.role as "PRIMARY" | "MARK_SCHEME" | "SOLUTIONS" | "SUPPLEMENT",
				rawPath: `raw/${f.filename}`,
				processedPath: f.processedPath ? `processed/${basename(f.processedPath)}` : null,
				pageCount: f.pageCount,
				fileSize: f.fileSize,
			})),
			chunks: resource.chunks.map((c) => ({
				id: c.id,
				sourceFileId: c.sourceFileId,
				parentId: c.parentId,
				index: c.index,
				depth: c.depth,
				nodeType: c.nodeType,
				slug: c.slug,
				diskPath: c.diskPath,
				title: c.title,
				content: c.content,
				startPage: c.startPage,
				endPage: c.endPage,
				keywords: c.keywords,
			})),
		};

		archive.append(JSON.stringify(resourceExport, null, 2), {
			name: `${resourcePrefix}/resource.json`,
		});

		// Copy raw files from disk
		for (const file of resource.files) {
			await appendFileIfExists(archive, file.rawPath, `${resourcePrefix}/raw/${file.filename}`);
		}

		// Copy processed files from disk
		for (const file of resource.files) {
			if (file.processedPath) {
				await appendFileIfExists(
					archive,
					file.processedPath,
					`${resourcePrefix}/processed/${basename(file.processedPath)}`,
				);
			}
		}

		// Copy tree directory
		const treeDir = join(resourceDir, "tree");
		await appendDirectoryIfExists(archive, treeDir, `${resourcePrefix}/tree`);
	}

	// 6. Concepts
	const conceptsExport: ConceptExport[] = session.concepts.map((c) => ({
		id: c.id,
		name: c.name,
		description: c.description,
		aliases: c.aliases,
		createdBy: c.createdBy,
	}));
	archive.append(JSON.stringify(conceptsExport, null, 2), { name: "concepts.json" });

	// 7. Relationships
	const relationshipsExport: RelationshipExport[] = session.relationships.map((r) => ({
		id: r.id,
		sourceType: r.sourceType,
		sourceId: r.sourceId,
		sourceLabel: r.sourceLabel,
		targetType: r.targetType,
		targetId: r.targetId,
		targetLabel: r.targetLabel,
		relationship: r.relationship,
		confidence: r.confidence,
		createdBy: r.createdBy,
	}));
	archive.append(JSON.stringify(relationshipsExport, null, 2), { name: "relationships.json" });

	// 8. Conversations + attachments
	for (const conv of session.conversations) {
		const convExport: ConversationExport = {
			id: conv.id,
			title: conv.title,
			messages: conv.messages.map((m) => ({
				id: m.id,
				role: m.role,
				content: m.content,
				toolCalls: m.toolCalls,
				attachments: m.attachments
					.filter((a) => a.messageId !== null)
					.map((a) => ({
						id: a.id,
						filename: a.filename,
						contentType: a.contentType,
						fileSize: a.fileSize,
					})),
			})),
		};

		archive.append(JSON.stringify(convExport, null, 2), {
			name: `conversations/${conv.id}.json`,
		});

		// Copy attachment binaries
		for (const msg of conv.messages) {
			for (const att of msg.attachments) {
				if (att.messageId === null) continue; // skip orphans
				const ext = att.filename.split(".").pop() ?? "bin";
				await appendFileIfExists(archive, att.diskPath, `attachments/${att.id}.${ext}`);
			}
		}
	}

	// 9. README.txt
	const readme = buildReadme(session.name, manifest);
	archive.append(readme, { name: "README.txt" });

	// Finalize and collect buffer
	await archive.finalize();

	const buffer = Buffer.concat(chunks);
	log.info(
		`exportSession — completed "${session.name}" (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`,
	);
	return buffer;
}

/**
 * Append a file to the archive if it exists on disk. Log and skip if missing.
 */
async function appendFileIfExists(
	archive: archiver.Archiver,
	diskPath: string,
	zipPath: string,
): Promise<void> {
	try {
		await stat(diskPath);
		archive.append(createReadStream(diskPath), { name: zipPath });
	} catch {
		log.warn(`appendFileIfExists — missing file: ${diskPath}`);
	}
}

/**
 * Recursively append a directory's contents to the archive.
 */
async function appendDirectoryIfExists(
	archive: archiver.Archiver,
	dirPath: string,
	zipPrefix: string,
): Promise<void> {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dirPath, entry.name);
			const zipPath = `${zipPrefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await appendDirectoryIfExists(archive, fullPath, zipPath);
			} else {
				archive.append(createReadStream(fullPath), { name: zipPath });
			}
		}
	} catch {
		log.debug(`appendDirectoryIfExists — directory not found: ${dirPath}`);
	}
}

/**
 * Build a human-readable README for the export.
 */
function buildReadme(sessionName: string, manifest: ExportManifest): string {
	const lines: string[] = [];
	lines.push("CramKit Session Export");
	lines.push("======================");
	lines.push("");
	lines.push(`Session: ${sessionName}`);
	if (manifest.session.module) lines.push(`Module: ${manifest.session.module}`);
	if (manifest.session.examDate) lines.push(`Exam Date: ${manifest.session.examDate}`);
	if (manifest.session.scope) lines.push(`Scope: ${manifest.session.scope}`);
	if (manifest.session.notes) lines.push(`Notes: ${manifest.session.notes}`);
	lines.push("");
	lines.push(`Exported: ${manifest.exportedAt}`);
	lines.push(`Format Version: ${manifest.version}`);
	lines.push("");
	lines.push("Contents");
	lines.push("--------");
	lines.push(`Resources: ${manifest.stats.resourceCount}`);
	lines.push(`Files: ${manifest.stats.fileCount}`);
	lines.push(`Chunks: ${manifest.stats.chunkCount}`);
	lines.push(`Concepts: ${manifest.stats.conceptCount}`);
	lines.push(`Relationships: ${manifest.stats.relationshipCount}`);
	lines.push(`Conversations: ${manifest.stats.conversationCount}`);
	lines.push(`Messages: ${manifest.stats.messageCount}`);
	lines.push("");
	lines.push("This archive was created by CramKit and can be imported");
	lines.push("into another CramKit instance using the Import feature.");
	return lines.join("\n");
}
