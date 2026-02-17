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

function sumBy<T>(arr: T[], fn: (item: T) => number): number {
	return arr.reduce((sum, item) => sum + fn(item), 0);
}

// biome-ignore lint/suspicious/noExplicitAny: generic utility
function pick<T extends Record<string, any>, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
	const result = {} as Pick<T, K>;
	for (const key of keys) {
		result[key] = obj[key];
	}
	return result;
}

/**
 * Export a session as a zip archive buffer.
 * Includes all resources (files, chunks, tree), concepts, relationships,
 * conversations (messages + attachments), and a human-readable README.
 */
export async function exportSession(sessionId: string): Promise<Buffer> {
	const db = getDb();

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

	const manifest = buildManifest(session);
	const archive = archiver("zip", { zlib: { level: 6 } });
	const chunks: Buffer[] = [];

	archive.on("data", (chunk: Buffer) => chunks.push(chunk));
	archive.on("warning", (err) => log.warn(`archiver warning: ${err.message}`));
	archive.on("error", (err) => {
		throw err;
	});

	appendJson(archive, manifest, "manifest.json");
	await addResourcesToArchive(archive, sessionId, session.resources);
	appendJson(archive, session.concepts.map(mapConcept), "concepts.json");
	appendJson(archive, session.relationships.map(mapRelationship), "relationships.json");
	await addConversationsToArchive(archive, session.conversations);
	archive.append(buildReadme(session.name, manifest), { name: "README.txt" });

	await archive.finalize();

	const buffer = Buffer.concat(chunks);
	log.info(
		`exportSession — completed "${session.name}" (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`,
	);
	return buffer;
}

function appendJson(archive: archiver.Archiver, data: unknown, zipPath: string): void {
	archive.append(JSON.stringify(data, null, 2), { name: zipPath });
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
function buildManifest(session: any): ExportManifest {
	return {
		version: 1,
		exportedAt: new Date().toISOString(),
		session: {
			name: session.name,
			module: session.module,
			examDate: session.examDate?.toISOString() ?? null,
			scope: session.scope,
			notes: session.notes,
		},
		resourceIds: session.resources.map((r: { id: string }) => r.id),
		conversationIds: session.conversations.map((c: { id: string }) => c.id),
		stats: {
			resourceCount: session.resources.length,
			fileCount: sumBy(session.resources, (r: { files: unknown[] }) => r.files.length),
			chunkCount: sumBy(session.resources, (r: { chunks: unknown[] }) => r.chunks.length),
			conceptCount: session.concepts.length,
			relationshipCount: session.relationships.length,
			conversationCount: session.conversations.length,
			messageCount: sumBy(session.conversations, (c: { messages: unknown[] }) => c.messages.length),
		},
	};
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
function mapResourceExport(resource: any): ResourceExport {
	return {
		...pick(resource, ["id", "name", "label", "splitMode", "isIndexed", "isGraphIndexed"]),
		type: resource.type as ResourceExport["type"],
		// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
		files: resource.files.map((f: any) => ({
			...pick(f, ["id", "filename", "pageCount", "fileSize"]),
			role: f.role as "PRIMARY" | "MARK_SCHEME" | "SOLUTIONS" | "SUPPLEMENT",
			rawPath: `raw/${f.filename}`,
			processedPath: f.processedPath ? `processed/${basename(f.processedPath)}` : null,
		})),
		// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
		chunks: resource.chunks.map((c: any) =>
			pick(c, [
				"id",
				"sourceFileId",
				"parentId",
				"index",
				"depth",
				"nodeType",
				"slug",
				"diskPath",
				"title",
				"content",
				"startPage",
				"endPage",
				"keywords",
			]),
		),
	};
}

async function addResourcesToArchive(
	archive: archiver.Archiver,
	sessionId: string,
	// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
	resources: any[],
): Promise<void> {
	for (const resource of resources) {
		const prefix = `resources/${resource.id}`;
		const resourceDir = getResourceDir(sessionId, resource.id);

		appendJson(archive, mapResourceExport(resource), `${prefix}/resource.json`);

		for (const file of resource.files) {
			await appendFileIfExists(archive, file.rawPath, `${prefix}/raw/${file.filename}`);
			if (file.processedPath) {
				await appendFileIfExists(
					archive,
					file.processedPath,
					`${prefix}/processed/${basename(file.processedPath)}`,
				);
			}
		}

		await appendDirectoryIfExists(archive, join(resourceDir, "tree"), `${prefix}/tree`);
	}
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
function mapMessage(m: any) {
	return {
		id: m.id,
		role: m.role,
		content: m.content,
		toolCalls: m.toolCalls,
		attachments: m.attachments
			// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
			.filter((a: any) => a.messageId !== null)
			// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
			.map((a: any) => pick(a, ["id", "filename", "contentType", "fileSize"])),
	};
}

async function addConversationsToArchive(
	archive: archiver.Archiver,
	// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
	conversations: any[],
): Promise<void> {
	for (const conv of conversations) {
		const convExport: ConversationExport = {
			id: conv.id,
			title: conv.title,
			messages: conv.messages.map(mapMessage),
		};

		appendJson(archive, convExport, `conversations/${conv.id}.json`);

		for (const msg of conv.messages) {
			for (const att of msg.attachments) {
				if (att.messageId === null) continue;
				const ext = att.filename.split(".").pop() ?? "bin";
				await appendFileIfExists(archive, att.diskPath, `attachments/${att.id}.${ext}`);
			}
		}
	}
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
function mapConcept(c: any): ConceptExport {
	return pick(c, ["id", "name", "description", "aliases", "createdBy"]);
}

// biome-ignore lint/suspicious/noExplicitAny: Prisma query result
function mapRelationship(r: any): RelationshipExport {
	return pick(r, [
		"id",
		"sourceType",
		"sourceId",
		"sourceLabel",
		"targetType",
		"targetId",
		"targetLabel",
		"relationship",
		"confidence",
		"createdBy",
	]);
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
	const s = manifest.session;
	const meta = [
		`Session: ${sessionName}`,
		s.module && `Module: ${s.module}`,
		s.examDate && `Exam Date: ${s.examDate}`,
		s.scope && `Scope: ${s.scope}`,
		s.notes && `Notes: ${s.notes}`,
	].filter(Boolean);

	const st = manifest.stats;
	const stats = [
		`Resources: ${st.resourceCount}`,
		`Files: ${st.fileCount}`,
		`Chunks: ${st.chunkCount}`,
		`Concepts: ${st.conceptCount}`,
		`Relationships: ${st.relationshipCount}`,
		`Conversations: ${st.conversationCount}`,
		`Messages: ${st.messageCount}`,
	];

	return [
		"CramKit Session Export",
		"======================",
		"",
		...meta,
		"",
		`Exported: ${manifest.exportedAt}`,
		`Format Version: ${manifest.version}`,
		"",
		"Contents",
		"--------",
		...stats,
		"",
		"This archive was created by CramKit and can be imported",
		"into another CramKit instance using the Import feature.",
	].join("\n");
}
