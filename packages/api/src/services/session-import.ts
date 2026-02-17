import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	conceptExportSchema,
	conversationExportSchema,
	createLogger,
	exportManifestSchema,
	getDb,
	relationshipExportSchema,
	resourceExportSchema,
} from "@cramkit/shared";
import type { ImportStats } from "@cramkit/shared";
import JSZip from "jszip";

const log = createLogger("import");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "..", "data");

function getResourceDir(sessionId: string, resourceId: string): string {
	return join(DATA_DIR, "sessions", sessionId, "resources", resourceId);
}

function getAttachmentsDir(): string {
	return join(DATA_DIR, "chat-attachments");
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

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

interface IdMaps {
	resource: Map<string, string>;
	file: Map<string, string>;
	chunk: Map<string, string>;
	concept: Map<string, string>;
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

const ENTITY_MAP_KEYS: Record<string, keyof IdMaps> = {
	resource: "resource",
	chunk: "chunk",
	concept: "concept",
};

function remapEntityId(entityType: string, oldId: string, maps: IdMaps): string | null {
	const key = ENTITY_MAP_KEYS[entityType];
	if (!key) {
		log.warn(`importSession — unknown entity type "${entityType}" for ID ${oldId}`);
		return null;
	}
	return maps[key].get(oldId) ?? null;
}

async function writeZipFileToDisk(zip: JSZip, zipPath: string, destPath: string): Promise<boolean> {
	const content = await readZipBinary(zip, zipPath);
	if (!content) return false;
	await ensureDir(dirname(destPath));
	await writeFile(destPath, content);
	return true;
}

async function restoreProcessedFile(
	ctx: ImportContext,
	oldResourceId: string,
	processedPath: string,
	newResourceDir: string,
): Promise<string | null> {
	const processedFilename = processedPath.split("/").pop() ?? processedPath;
	const diskPath = join(newResourceDir, "processed", processedFilename);
	const wrote = await writeZipFileToDisk(
		ctx.zip,
		`resources/${oldResourceId}/${processedPath}`,
		diskPath,
	);
	return wrote ? diskPath : null;
}

async function importResourceFiles(
	ctx: ImportContext,
	oldResourceId: string,
	files: Array<{
		id: string;
		filename: string;
		role: string;
		processedPath?: string | null;
		pageCount?: number | null;
		fileSize?: number | null;
	}>,
	newResourceId: string,
	newResourceDir: string,
): Promise<void> {
	for (const fileEntry of files) {
		const rawDest = join(newResourceDir, "raw", fileEntry.filename);
		const wrote = await writeZipFileToDisk(
			ctx.zip,
			`resources/${oldResourceId}/raw/${fileEntry.filename}`,
			rawDest,
		);
		if (!wrote) {
			log.warn(`importSession — missing raw file for "${fileEntry.filename}", skipping`);
			continue;
		}

		const processedDiskPath = fileEntry.processedPath
			? await restoreProcessedFile(ctx, oldResourceId, fileEntry.processedPath, newResourceDir)
			: null;

		if (fileEntry.processedPath && !processedDiskPath) {
			log.warn(`importSession — missing processed file for "${fileEntry.filename}"`);
		}

		const file = await ctx.db.file.create({
			data: {
				resourceId: newResourceId,
				filename: fileEntry.filename,
				role: fileEntry.role,
				rawPath: rawDest,
				processedPath: processedDiskPath,
				pageCount: fileEntry.pageCount ?? null,
				fileSize: fileEntry.fileSize ?? null,
			},
		});
		ctx.maps.file.set(fileEntry.id, file.id);
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
		const destPath = join(newResourceDir, "tree", relativePath);
		await writeZipFileToDisk(zip, treePath, destPath);
	}
}

async function importResourceChunks(
	ctx: ImportContext,
	chunks: Array<{
		id: string;
		sourceFileId?: string | null;
		parentId?: string | null;
		index: number;
		depth: number;
		nodeType: string;
		slug?: string | null;
		diskPath?: string | null;
		title?: string | null;
		content: string;
		startPage?: number | null;
		endPage?: number | null;
		keywords?: string | null;
	}>,
	newResourceId: string,
): Promise<void> {
	const sorted = [...chunks].sort((a, b) => a.depth - b.depth || a.index - b.index);

	const remap = (map: Map<string, string>, id?: string | null) =>
		id ? (map.get(id) ?? null) : null;

	for (const entry of sorted) {
		const newSourceFileId = remap(ctx.maps.file, entry.sourceFileId);
		const newParentId = remap(ctx.maps.chunk, entry.parentId);

		const chunk = await ctx.db.chunk.create({
			data: {
				resourceId: newResourceId,
				sourceFileId: newSourceFileId,
				parentId: newParentId,
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
			},
		});
		ctx.maps.chunk.set(entry.id, chunk.id);
		ctx.stats.chunkCount++;
	}
}

async function importResources(ctx: ImportContext, resourceIds: string[]): Promise<void> {
	for (const oldResourceId of resourceIds) {
		const rawResource = await readZipJson(
			ctx.zip,
			`resources/${oldResourceId}/resource.json`,
			true,
		);
		if (!rawResource) {
			log.warn(`importSession — missing resource ${oldResourceId}, skipping`);
			continue;
		}

		const resourceData = resourceExportSchema.parse(rawResource);

		const resource = await ctx.db.resource.create({
			data: {
				sessionId: ctx.sessionId,
				name: resourceData.name,
				type: resourceData.type,
				label: resourceData.label ?? null,
				splitMode: resourceData.splitMode,
				isIndexed: resourceData.isIndexed,
				isGraphIndexed: resourceData.isGraphIndexed,
			},
		});
		ctx.maps.resource.set(oldResourceId, resource.id);
		ctx.stats.resourceCount++;

		const newResourceDir = getResourceDir(ctx.sessionId, resource.id);

		await importResourceFiles(ctx, oldResourceId, resourceData.files, resource.id, newResourceDir);
		await copyTreeDirectory(ctx.zip, oldResourceId, newResourceDir);
		await importResourceChunks(ctx, resourceData.chunks, resource.id);

		log.debug(
			`importSession — imported resource "${resourceData.name}" (${resourceData.files.length} files, ${resourceData.chunks.length} chunks)`,
		);
	}
}

async function importConcepts(ctx: ImportContext): Promise<void> {
	const rawConcepts = await readZipJson(ctx.zip, "concepts.json", true);
	if (!rawConcepts) return;

	const concepts = conceptExportSchema.array().parse(rawConcepts);

	for (const entry of concepts) {
		const concept = await ctx.db.concept.create({
			data: {
				sessionId: ctx.sessionId,
				name: entry.name,
				description: entry.description ?? null,
				aliases: entry.aliases ?? null,
				createdBy: entry.createdBy,
			},
		});
		ctx.maps.concept.set(entry.id, concept.id);
		ctx.stats.conceptCount++;
	}

	log.debug(`importSession — imported ${ctx.stats.conceptCount} concepts`);
}

async function importRelationships(ctx: ImportContext): Promise<void> {
	const rawRelationships = await readZipJson(ctx.zip, "relationships.json", true);
	if (!rawRelationships) return;

	const relationships = relationshipExportSchema.array().parse(rawRelationships);

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

async function importMessageAttachments(
	ctx: ImportContext,
	attachments: Array<{ id: string; filename: string; contentType: string; fileSize: number }>,
	messageId: string,
): Promise<void> {
	const attachmentsDir = getAttachmentsDir();
	await ensureDir(attachmentsDir);

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
		const rawConv = await readZipJson(ctx.zip, `conversations/${oldConvId}.json`, true);
		if (!rawConv) {
			log.warn(`importSession — missing conversation ${oldConvId}, skipping`);
			continue;
		}

		const convData = conversationExportSchema.parse(rawConv);

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

			if (msgEntry.attachments?.length) {
				await importMessageAttachments(ctx, msgEntry.attachments, message.id);
			}
		}

		log.debug(
			`importSession — imported conversation "${convData.title}" (${convData.messages.length} messages)`,
		);
	}
}

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
