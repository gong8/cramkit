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

async function readZipJson(zip: JSZip, path: string): Promise<unknown> {
	const file = zip.file(path);
	if (!file) {
		throw new Error(`Missing file in zip: ${path}`);
	}
	const text = await file.async("string");
	return JSON.parse(text);
}

async function readZipBinary(zip: JSZip, path: string): Promise<Buffer | null> {
	const file = zip.file(path);
	if (!file) {
		return null;
	}
	return file.async("nodebuffer");
}

async function readOptionalZipJson(zip: JSZip, path: string): Promise<unknown | null> {
	const file = zip.file(path);
	if (!file) return null;
	const text = await file.async("string");
	return JSON.parse(text);
}

interface IdMaps {
	resource: Map<string, string>;
	file: Map<string, string>;
	chunk: Map<string, string>;
	concept: Map<string, string>;
	conversation: Map<string, string>;
	message: Map<string, string>;
}

function createIdMaps(): IdMaps {
	return {
		resource: new Map(),
		file: new Map(),
		chunk: new Map(),
		concept: new Map(),
		conversation: new Map(),
		message: new Map(),
	};
}

function createStats(): ImportStats {
	return {
		sessionId: "",
		resourceCount: 0,
		fileCount: 0,
		chunkCount: 0,
		conceptCount: 0,
		relationshipCount: 0,
		conversationCount: 0,
		messageCount: 0,
		attachmentCount: 0,
	};
}

function remapEntityId(entityType: string, oldId: string, maps: IdMaps): string | null {
	switch (entityType) {
		case "resource":
			return maps.resource.get(oldId) ?? null;
		case "chunk":
			return maps.chunk.get(oldId) ?? null;
		case "concept":
			return maps.concept.get(oldId) ?? null;
		default:
			log.warn(`importSession — unknown entity type "${entityType}" for ID ${oldId}`);
			return null;
	}
}

async function importResourceFiles(
	zip: JSZip,
	oldResourceId: string,
	resourceData: {
		files: Array<{
			id: string;
			filename: string;
			role: string;
			processedPath?: string | null;
			pageCount?: number | null;
			fileSize?: number | null;
		}>;
	},
	newResourceId: string,
	newResourceDir: string,
	maps: IdMaps,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	for (const fileEntry of resourceData.files) {
		const rawContent = await readZipBinary(
			zip,
			`resources/${oldResourceId}/raw/${fileEntry.filename}`,
		);
		if (!rawContent) {
			log.warn(`importSession — missing raw file for "${fileEntry.filename}", skipping`);
			continue;
		}

		const rawDir = join(newResourceDir, "raw");
		await ensureDir(rawDir);
		await writeFile(join(rawDir, fileEntry.filename), rawContent);

		let processedDiskPath: string | null = null;
		if (fileEntry.processedPath) {
			const processedContent = await readZipBinary(
				zip,
				`resources/${oldResourceId}/${fileEntry.processedPath}`,
			);
			if (processedContent) {
				const processedDir = join(newResourceDir, "processed");
				await ensureDir(processedDir);
				const processedFilename =
					fileEntry.processedPath.split("/").pop() ?? fileEntry.processedPath;
				processedDiskPath = join(processedDir, processedFilename);
				await writeFile(processedDiskPath, processedContent);
			} else {
				log.warn(`importSession — missing processed file for "${fileEntry.filename}"`);
			}
		}

		const file = await db.file.create({
			data: {
				resourceId: newResourceId,
				filename: fileEntry.filename,
				role: fileEntry.role,
				rawPath: join(newResourceDir, "raw", fileEntry.filename),
				processedPath: processedDiskPath,
				pageCount: fileEntry.pageCount ?? null,
				fileSize: fileEntry.fileSize ?? null,
			},
		});
		maps.file.set(fileEntry.id, file.id);
		stats.fileCount++;
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
		await ensureDir(dirname(destPath));
		const content = await readZipBinary(zip, treePath);
		if (content) {
			await writeFile(destPath, content);
		}
	}
}

async function importResourceChunks(
	resourceData: {
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
		}>;
	},
	newResourceId: string,
	maps: IdMaps,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	const sortedChunks = [...resourceData.chunks].sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		return a.index - b.index;
	});

	for (const chunkEntry of sortedChunks) {
		const newSourceFileId = chunkEntry.sourceFileId
			? (maps.file.get(chunkEntry.sourceFileId) ?? null)
			: null;
		const newParentId = chunkEntry.parentId ? (maps.chunk.get(chunkEntry.parentId) ?? null) : null;

		const chunk = await db.chunk.create({
			data: {
				resourceId: newResourceId,
				sourceFileId: newSourceFileId,
				parentId: newParentId,
				index: chunkEntry.index,
				depth: chunkEntry.depth,
				nodeType: chunkEntry.nodeType,
				slug: chunkEntry.slug ?? null,
				diskPath: chunkEntry.diskPath ?? null,
				title: chunkEntry.title ?? null,
				content: chunkEntry.content,
				startPage: chunkEntry.startPage ?? null,
				endPage: chunkEntry.endPage ?? null,
				keywords: chunkEntry.keywords ?? null,
			},
		});
		maps.chunk.set(chunkEntry.id, chunk.id);
		stats.chunkCount++;
	}
}

async function importResources(
	zip: JSZip,
	manifest: { resourceIds: string[] },
	sessionId: string,
	maps: IdMaps,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	for (const oldResourceId of manifest.resourceIds) {
		const rawResource = await readOptionalZipJson(zip, `resources/${oldResourceId}/resource.json`);
		if (!rawResource) {
			log.warn(`importSession — missing resource ${oldResourceId}, skipping`);
			continue;
		}

		const resourceData = resourceExportSchema.parse(rawResource);

		const resource = await db.resource.create({
			data: {
				sessionId,
				name: resourceData.name,
				type: resourceData.type,
				label: resourceData.label ?? null,
				splitMode: resourceData.splitMode,
				isIndexed: resourceData.isIndexed,
				isGraphIndexed: resourceData.isGraphIndexed,
			},
		});
		maps.resource.set(oldResourceId, resource.id);
		stats.resourceCount++;

		const newResourceDir = getResourceDir(sessionId, resource.id);

		await importResourceFiles(
			zip,
			oldResourceId,
			resourceData,
			resource.id,
			newResourceDir,
			maps,
			stats,
			db,
		);
		await copyTreeDirectory(zip, oldResourceId, newResourceDir);
		await importResourceChunks(resourceData, resource.id, maps, stats, db);

		log.debug(
			`importSession — imported resource "${resourceData.name}" (${resourceData.files.length} files, ${resourceData.chunks.length} chunks)`,
		);
	}
}

async function importConcepts(
	zip: JSZip,
	sessionId: string,
	maps: IdMaps,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	const rawConcepts = await readOptionalZipJson(zip, "concepts.json");
	if (!rawConcepts) return;

	const concepts = conceptExportSchema.array().parse(rawConcepts);

	for (const conceptEntry of concepts) {
		const concept = await db.concept.create({
			data: {
				sessionId,
				name: conceptEntry.name,
				description: conceptEntry.description ?? null,
				aliases: conceptEntry.aliases ?? null,
				createdBy: conceptEntry.createdBy,
			},
		});
		maps.concept.set(conceptEntry.id, concept.id);
		stats.conceptCount++;
	}

	log.debug(`importSession — imported ${stats.conceptCount} concepts`);
}

async function importRelationships(
	zip: JSZip,
	sessionId: string,
	maps: IdMaps,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	const rawRelationships = await readOptionalZipJson(zip, "relationships.json");
	if (!rawRelationships) return;

	const relationships = relationshipExportSchema.array().parse(rawRelationships);

	for (const relEntry of relationships) {
		const newSourceId = remapEntityId(relEntry.sourceType, relEntry.sourceId, maps);
		if (!newSourceId) {
			log.warn(
				`importSession — skipping relationship: missing ${relEntry.sourceType} source ${relEntry.sourceId}`,
			);
			continue;
		}

		const newTargetId = remapEntityId(relEntry.targetType, relEntry.targetId, maps);
		if (!newTargetId) {
			log.warn(
				`importSession — skipping relationship: missing ${relEntry.targetType} target ${relEntry.targetId}`,
			);
			continue;
		}

		await db.relationship.create({
			data: {
				sessionId,
				sourceType: relEntry.sourceType,
				sourceId: newSourceId,
				sourceLabel: relEntry.sourceLabel ?? null,
				targetType: relEntry.targetType,
				targetId: newTargetId,
				targetLabel: relEntry.targetLabel ?? null,
				relationship: relEntry.relationship,
				confidence: relEntry.confidence,
				createdBy: relEntry.createdBy,
			},
		});
		stats.relationshipCount++;
	}

	log.debug(`importSession — imported ${stats.relationshipCount} relationships`);
}

async function importMessageAttachments(
	zip: JSZip,
	attachments: Array<{ id: string; filename: string; contentType: string; fileSize: number }>,
	messageId: string,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	const attachmentsDir = getAttachmentsDir();
	await ensureDir(attachmentsDir);

	for (const attEntry of attachments) {
		const ext = extname(attEntry.filename) || ".bin";
		const attachmentContent = await readZipBinary(zip, `attachments/${attEntry.id}${ext}`);

		if (!attachmentContent) {
			log.warn(`importSession — missing attachment ${attEntry.id}, skipping`);
			continue;
		}

		const newFilename = `${messageId}-${attEntry.filename}`;
		const diskPath = join(attachmentsDir, newFilename);
		await writeFile(diskPath, attachmentContent);

		await db.chatAttachment.create({
			data: {
				messageId,
				filename: attEntry.filename,
				contentType: attEntry.contentType,
				diskPath,
				fileSize: attEntry.fileSize,
			},
		});
		stats.attachmentCount++;
	}
}

async function importConversations(
	zip: JSZip,
	manifest: { conversationIds: string[] },
	sessionId: string,
	maps: IdMaps,
	stats: ImportStats,
	db: ReturnType<typeof getDb>,
): Promise<void> {
	for (const oldConvId of manifest.conversationIds) {
		const rawConv = await readOptionalZipJson(zip, `conversations/${oldConvId}.json`);
		if (!rawConv) {
			log.warn(`importSession — missing conversation ${oldConvId}, skipping`);
			continue;
		}

		const convData = conversationExportSchema.parse(rawConv);

		const conversation = await db.conversation.create({
			data: { sessionId, title: convData.title },
		});
		maps.conversation.set(oldConvId, conversation.id);
		stats.conversationCount++;

		for (const msgEntry of convData.messages) {
			const message = await db.message.create({
				data: {
					conversationId: conversation.id,
					role: msgEntry.role,
					content: msgEntry.content,
					toolCalls: msgEntry.toolCalls ?? null,
				},
			});
			maps.message.set(msgEntry.id, message.id);
			stats.messageCount++;

			if (msgEntry.attachments?.length) {
				await importMessageAttachments(zip, msgEntry.attachments, message.id, stats, db);
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

	const maps = createIdMaps();
	const stats = createStats();

	const session = await db.session.create({
		data: {
			name: manifest.session.name,
			module: manifest.session.module ?? null,
			examDate: manifest.session.examDate ? new Date(manifest.session.examDate) : null,
			scope: manifest.session.scope ?? null,
			notes: manifest.session.notes ?? null,
		},
	});
	stats.sessionId = session.id;
	log.info(`importSession — created session ${session.id}`);

	try {
		await importResources(zip, manifest, session.id, maps, stats, db);
		await importConcepts(zip, session.id, maps, stats, db);
		await importRelationships(zip, session.id, maps, stats, db);
		await importConversations(zip, manifest, session.id, maps, stats, db);

		log.info(
			`importSession — completed: ${stats.resourceCount} resources, ${stats.fileCount} files, ${stats.chunkCount} chunks, ${stats.conceptCount} concepts, ${stats.relationshipCount} relationships, ${stats.conversationCount} conversations, ${stats.messageCount} messages, ${stats.attachmentCount} attachments`,
		);

		return stats;
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
