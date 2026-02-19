import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ImportStats,
	conceptExportSchema,
	conversationExportSchema,
	createLogger,
	exportManifestSchema,
	getDb,
	paperQuestionExportSchema,
	relationshipExportSchema,
	resourceExportSchema,
} from "@cramkit/shared";
import JSZip from "jszip";
import type { z } from "zod";

const log = createLogger("import");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");

function getResourceDir(sessionId: string, resourceId: string): string {
	return join(DATA_DIR, "sessions", sessionId, "resources", resourceId);
}

function getAttachmentsDir(): string {
	return join(DATA_DIR, "chat-attachments");
}

// ── Zip helpers ──────────────────────────────────────────────────────────────

async function readZipJson(zip: JSZip, path: string, optional: true): Promise<unknown | null>;
async function readZipJson(zip: JSZip, path: string, optional?: false): Promise<unknown>;
async function readZipJson(zip: JSZip, path: string, optional = false): Promise<unknown | null> {
	const file = zip.file(path);
	if (!file) {
		if (optional) return null;
		throw new Error(`Missing file in zip: ${path}`);
	}
	const text = await file.async("string");
	return JSON.parse(text);
}

async function readZipBinary(zip: JSZip, path: string): Promise<Buffer | null> {
	const file = zip.file(path);
	if (!file) return null;
	return file.async("nodebuffer");
}

async function writeZipFileToDisk(zip: JSZip, zipPath: string, destPath: string): Promise<boolean> {
	const content = await readZipBinary(zip, zipPath);
	if (!content) return false;
	await mkdir(dirname(destPath), { recursive: true });
	await writeFile(destPath, content);
	return true;
}

// ── Import context ───────────────────────────────────────────────────────────

interface IdMaps {
	resource: Map<string, string>;
	file: Map<string, string>;
	chunk: Map<string, string>;
	concept: Map<string, string>;
	question: Map<string, string>;
	conversation: Map<string, string>;
	message: Map<string, string>;
}

interface ImportContext {
	zip: JSZip;
	maps: IdMaps;
	stats: ImportStats;
	db: ReturnType<typeof getDb>;
	sessionId: string;
}

function createContext(zip: JSZip, db: ReturnType<typeof getDb>, sessionId: string): ImportContext {
	return {
		zip,
		db,
		sessionId,
		maps: {
			resource: new Map(),
			file: new Map(),
			chunk: new Map(),
			concept: new Map(),
			question: new Map(),
			conversation: new Map(),
			message: new Map(),
		},
		stats: {
			sessionId,
			resourceCount: 0,
			fileCount: 0,
			chunkCount: 0,
			conceptCount: 0,
			relationshipCount: 0,
			conversationCount: 0,
			messageCount: 0,
			attachmentCount: 0,
		},
	};
}

function remapId(maps: IdMaps, mapKey: keyof IdMaps, oldId?: string | null): string | null {
	if (!oldId) return null;
	return maps[mapKey].get(oldId) ?? null;
}

const ENTITY_MAP_KEYS: Record<string, keyof IdMaps> = {
	resource: "resource",
	chunk: "chunk",
	concept: "concept",
	question: "question",
};

function remapEntityId(entityType: string, oldId: string, maps: IdMaps): string | null {
	const key = ENTITY_MAP_KEYS[entityType];
	if (!key) {
		log.warn(`importSession — unknown entity type "${entityType}" for ID ${oldId}`);
		return null;
	}
	return maps[key].get(oldId) ?? null;
}

// ── Schema types ─────────────────────────────────────────────────────────────

type ResourceExport = z.infer<typeof resourceExportSchema>;
type FileEntry = ResourceExport["files"][number];
type ChunkEntry = ResourceExport["chunks"][number];

// ── Resource import ──────────────────────────────────────────────────────────

async function importResourceFiles(
	ctx: ImportContext,
	oldResourceId: string,
	files: FileEntry[],
	newResourceId: string,
	newResourceDir: string,
): Promise<void> {
	for (const f of files) {
		const rawDest = join(newResourceDir, "raw", f.filename);
		const wrote = await writeZipFileToDisk(
			ctx.zip,
			`resources/${oldResourceId}/raw/${f.filename}`,
			rawDest,
		);
		if (!wrote) {
			log.warn(`importSession — missing raw file for "${f.filename}", skipping`);
			continue;
		}

		let processedDiskPath: string | null = null;
		if (f.processedPath) {
			const processedFilename = f.processedPath.split("/").pop() ?? f.processedPath;
			const diskPath = join(newResourceDir, "processed", processedFilename);
			const wroteProcessed = await writeZipFileToDisk(
				ctx.zip,
				`resources/${oldResourceId}/${f.processedPath}`,
				diskPath,
			);
			processedDiskPath = wroteProcessed ? diskPath : null;
			if (!wroteProcessed) {
				log.warn(`importSession — missing processed file for "${f.filename}"`);
			}
		}

		const file = await ctx.db.file.create({
			data: {
				resourceId: newResourceId,
				filename: f.filename,
				role: f.role,
				rawPath: rawDest,
				processedPath: processedDiskPath,
				pageCount: f.pageCount ?? null,
				fileSize: f.fileSize ?? null,
			},
		});
		ctx.maps.file.set(f.id, file.id);
		ctx.stats.fileCount++;
	}
}

async function copyTreeDirectory(
	zip: JSZip,
	oldResourceId: string,
	newResourceDir: string,
): Promise<void> {
	const treePrefix = `resources/${oldResourceId}/tree/`;
	const treeFiles = Object.keys(zip.files).filter(
		(p) => p.startsWith(treePrefix) && !zip.files[p].dir,
	);
	for (const treePath of treeFiles) {
		const relativePath = treePath.slice(treePrefix.length);
		await writeZipFileToDisk(zip, treePath, join(newResourceDir, "tree", relativePath));
	}
}

async function importResourceChunks(
	ctx: ImportContext,
	chunks: ChunkEntry[],
	newResourceId: string,
): Promise<void> {
	const sorted = [...chunks].sort((a, b) => a.depth - b.depth || a.index - b.index);

	for (const entry of sorted) {
		const chunk = await ctx.db.chunk.create({
			data: {
				resourceId: newResourceId,
				sourceFileId: remapId(ctx.maps, "file", entry.sourceFileId),
				parentId: remapId(ctx.maps, "chunk", entry.parentId),
				index: entry.index,
				depth: entry.depth,
				nodeType: entry.nodeType,
				slug: entry.slug ?? null,
				diskPath: entry.diskPath ?? null,
				title: entry.title ?? null,
				content: entry.content,
				startPage: entry.startPage ?? null,
				endPage: entry.endPage ?? null,
				keywords: entry.keywords ?? null,
				metadata: (entry as { metadata?: string | null }).metadata ?? null,
			},
		});
		ctx.maps.chunk.set(entry.id, chunk.id);
		ctx.stats.chunkCount++;
	}
}

async function importQuestions(
	ctx: ImportContext,
	oldResourceId: string,
	newResourceId: string,
): Promise<void> {
	const raw = await readZipJson(ctx.zip, `resources/${oldResourceId}/questions.json`, true);
	if (!raw) return;

	const questions = paperQuestionExportSchema.array().parse(raw);
	for (const q of questions) {
		const pq = await ctx.db.paperQuestion.create({
			data: {
				resourceId: newResourceId,
				sessionId: ctx.sessionId,
				chunkId: remapId(ctx.maps, "chunk", q.chunkId),
				questionNumber: q.questionNumber,
				parentNumber: q.parentNumber ?? null,
				marks: q.marks ?? null,
				questionType: q.questionType ?? null,
				commandWords: q.commandWords ?? null,
				content: q.content,
				markSchemeText: q.markSchemeText ?? null,
				solutionText: q.solutionText ?? null,
				metadata: q.metadata ?? null,
			},
		});
		ctx.maps.question.set(q.id, pq.id);
	}
	log.debug(`importSession — imported ${questions.length} questions for resource ${newResourceId}`);
}

async function importSingleResource(ctx: ImportContext, oldResourceId: string): Promise<void> {
	const raw = await readZipJson(ctx.zip, `resources/${oldResourceId}/resource.json`, true);
	if (!raw) {
		log.warn(`importSession — missing resource ${oldResourceId}, skipping`);
		return;
	}

	const data = resourceExportSchema.parse(raw);

	const resource = await ctx.db.resource.create({
		data: {
			sessionId: ctx.sessionId,
			name: data.name,
			type: data.type,
			label: data.label ?? null,
			splitMode: data.splitMode,
			isIndexed: data.isIndexed,
			isGraphIndexed: data.isGraphIndexed,
			metadata: data.metadata ?? null,
			isMetaIndexed: data.isMetaIndexed ?? false,
			metaIndexDurationMs: data.metaIndexDurationMs ?? null,
		},
	});
	ctx.maps.resource.set(oldResourceId, resource.id);
	ctx.stats.resourceCount++;

	const newResourceDir = getResourceDir(ctx.sessionId, resource.id);

	await importResourceFiles(ctx, oldResourceId, data.files, resource.id, newResourceDir);
	await copyTreeDirectory(ctx.zip, oldResourceId, newResourceDir);
	await importResourceChunks(ctx, data.chunks, resource.id);
	await importQuestions(ctx, oldResourceId, resource.id);

	log.debug(
		`importSession — imported resource "${data.name}" (${data.files.length} files, ${data.chunks.length} chunks)`,
	);
}

async function importResources(ctx: ImportContext, resourceIds: string[]): Promise<void> {
	for (const id of resourceIds) {
		await importSingleResource(ctx, id);
	}
}

// ── Knowledge graph import ───────────────────────────────────────────────────

async function importConcepts(ctx: ImportContext): Promise<void> {
	const raw = await readZipJson(ctx.zip, "concepts.json", true);
	if (!raw) return;

	const concepts = conceptExportSchema.array().parse(raw);

	for (const entry of concepts) {
		const concept = await ctx.db.concept.create({
			data: {
				sessionId: ctx.sessionId,
				name: entry.name,
				description: entry.description ?? null,
				aliases: entry.aliases ?? null,
				content: entry.content ?? null,
				contentType: entry.contentType ?? null,
				metadata: entry.metadata ?? null,
				createdBy: entry.createdBy,
			},
		});
		ctx.maps.concept.set(entry.id, concept.id);
		ctx.stats.conceptCount++;
	}

	log.debug(`importSession — imported ${ctx.stats.conceptCount} concepts`);
}

async function importRelationships(ctx: ImportContext): Promise<void> {
	const raw = await readZipJson(ctx.zip, "relationships.json", true);
	if (!raw) return;

	const relationships = relationshipExportSchema.array().parse(raw);

	for (const entry of relationships) {
		const newSourceId = remapEntityId(entry.sourceType, entry.sourceId, ctx.maps);
		const newTargetId = remapEntityId(entry.targetType, entry.targetId, ctx.maps);
		if (!newSourceId || !newTargetId) {
			const side = !newSourceId ? "source" : "target";
			const type = !newSourceId ? entry.sourceType : entry.targetType;
			const id = !newSourceId ? entry.sourceId : entry.targetId;
			log.warn(`importSession — skipping relationship: missing ${type} ${side} ${id}`);
			continue;
		}

		await ctx.db.relationship.create({
			data: {
				sessionId: ctx.sessionId,
				sourceType: entry.sourceType,
				sourceId: newSourceId,
				sourceLabel: entry.sourceLabel ?? null,
				targetType: entry.targetType,
				targetId: newTargetId,
				targetLabel: entry.targetLabel ?? null,
				relationship: entry.relationship,
				confidence: entry.confidence,
				createdBy: entry.createdBy,
			},
		});
		ctx.stats.relationshipCount++;
	}

	log.debug(`importSession — imported ${ctx.stats.relationshipCount} relationships`);
}

// ── Conversation import ──────────────────────────────────────────────────────

async function importMessageAttachments(
	ctx: ImportContext,
	attachments: z.infer<typeof conversationExportSchema>["messages"][number]["attachments"],
	messageId: string,
): Promise<void> {
	if (!attachments?.length) return;

	const attachmentsDir = getAttachmentsDir();
	await mkdir(attachmentsDir, { recursive: true });

	for (const att of attachments) {
		const ext = extname(att.filename) || ".bin";
		const newFilename = `${messageId}-${att.filename}`;
		const diskPath = join(attachmentsDir, newFilename);

		const wrote = await writeZipFileToDisk(ctx.zip, `attachments/${att.id}${ext}`, diskPath);
		if (!wrote) {
			log.warn(`importSession — missing attachment ${att.id}, skipping`);
			continue;
		}

		await ctx.db.chatAttachment.create({
			data: {
				messageId,
				filename: att.filename,
				contentType: att.contentType,
				diskPath,
				fileSize: att.fileSize,
			},
		});
		ctx.stats.attachmentCount++;
	}
}

async function importConversations(ctx: ImportContext, conversationIds: string[]): Promise<void> {
	for (const oldConvId of conversationIds) {
		const raw = await readZipJson(ctx.zip, `conversations/${oldConvId}.json`, true);
		if (!raw) {
			log.warn(`importSession — missing conversation ${oldConvId}, skipping`);
			continue;
		}

		const convData = conversationExportSchema.parse(raw);

		const conversation = await ctx.db.conversation.create({
			data: { sessionId: ctx.sessionId, title: convData.title },
		});
		ctx.maps.conversation.set(oldConvId, conversation.id);
		ctx.stats.conversationCount++;

		for (const msgEntry of convData.messages) {
			const message = await ctx.db.message.create({
				data: {
					conversationId: conversation.id,
					role: msgEntry.role,
					content: msgEntry.content,
					toolCalls: msgEntry.toolCalls ?? null,
				},
			});
			ctx.maps.message.set(msgEntry.id, message.id);
			ctx.stats.messageCount++;

			await importMessageAttachments(ctx, msgEntry.attachments, message.id);
		}

		log.debug(
			`importSession — imported conversation "${convData.title}" (${convData.messages.length} messages)`,
		);
	}
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Import a session from a .cramkit.zip archive buffer.
 * Creates all entities with fresh IDs and copies files to disk.
 */
export async function importSession(zipBuffer: ArrayBuffer | Buffer): Promise<ImportStats> {
	const db = getDb();
	const zip = await JSZip.loadAsync(zipBuffer);

	const rawManifest = await readZipJson(zip, "manifest.json");
	const manifest = exportManifestSchema.parse(rawManifest);

	if (manifest.version !== 1) {
		throw new Error(
			`Unsupported export version: ${manifest.version}. Only version 1 is supported.`,
		);
	}

	log.info(
		`importSession — importing "${manifest.session.name}" (${manifest.stats.resourceCount} resources, ${manifest.stats.chunkCount} chunks)`,
	);

	const session = await db.session.create({
		data: {
			name: manifest.session.name,
			module: manifest.session.module ?? null,
			examDate: manifest.session.examDate ? new Date(manifest.session.examDate) : null,
			scope: manifest.session.scope ?? null,
			notes: manifest.session.notes ?? null,
		},
	});

	const ctx = createContext(zip, db, session.id);
	log.info(`importSession — created session ${session.id}`);

	try {
		await importResources(ctx, manifest.resourceIds);
		await importConcepts(ctx);
		await importRelationships(ctx);
		await importConversations(ctx, manifest.conversationIds);

		log.info(
			`importSession — completed: ${ctx.stats.resourceCount} resources, ${ctx.stats.fileCount} files, ${ctx.stats.chunkCount} chunks, ${ctx.stats.conceptCount} concepts, ${ctx.stats.relationshipCount} relationships, ${ctx.stats.conversationCount} conversations, ${ctx.stats.messageCount} messages, ${ctx.stats.attachmentCount} attachments`,
		);

		return ctx.stats;
	} catch (error) {
		log.error("importSession — critical error, attempting cleanup", error);
		try {
			await db.session.delete({ where: { id: session.id } });
			log.info(`importSession — cleaned up session ${session.id}`);
		} catch (cleanupError) {
			log.error("importSession — cleanup failed", cleanupError);
		}
		throw error;
	}
}
