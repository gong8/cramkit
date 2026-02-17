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
	const data = await file.async("nodebuffer");
	return data;
}

/**
 * Import a session from a .cramkit.zip archive buffer.
 * Creates all entities with fresh IDs and copies files to disk.
 */
export async function importSession(zipBuffer: ArrayBuffer | Buffer): Promise<ImportStats> {
	const db = getDb();
	const zip = await JSZip.loadAsync(zipBuffer);

	// 1. Parse and validate manifest
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

	// 2. ID remap maps
	const resourceMap = new Map<string, string>();
	const fileMap = new Map<string, string>();
	const chunkMap = new Map<string, string>();
	const conceptMap = new Map<string, string>();
	const conversationMap = new Map<string, string>();
	const messageMap = new Map<string, string>();

	// Stats counters
	const stats: ImportStats = {
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

	// 3. Create session
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
		// 4. Import resources
		for (const oldResourceId of manifest.resourceIds) {
			const resourceJsonPath = `resources/${oldResourceId}/resource.json`;
			let rawResource: unknown;
			try {
				rawResource = await readZipJson(zip, resourceJsonPath);
			} catch {
				log.warn(`importSession — missing ${resourceJsonPath}, skipping resource`);
				continue;
			}

			const resourceData = resourceExportSchema.parse(rawResource);

			const resource = await db.resource.create({
				data: {
					sessionId: session.id,
					name: resourceData.name,
					type: resourceData.type,
					label: resourceData.label ?? null,
					splitMode: resourceData.splitMode,
					isIndexed: resourceData.isIndexed,
					isGraphIndexed: resourceData.isGraphIndexed,
				},
			});
			resourceMap.set(oldResourceId, resource.id);
			stats.resourceCount++;

			const newResourceDir = getResourceDir(session.id, resource.id);

			// 4a. Import files
			for (const fileEntry of resourceData.files) {
				const rawZipPath = `resources/${oldResourceId}/raw/${fileEntry.filename}`;
				const rawContent = await readZipBinary(zip, rawZipPath);

				if (!rawContent) {
					log.warn(
						`importSession — missing raw file ${rawZipPath}, skipping file "${fileEntry.filename}"`,
					);
					continue;
				}

				// Save raw file to disk
				const rawDir = join(newResourceDir, "raw");
				await ensureDir(rawDir);
				const rawDiskPath = join(rawDir, fileEntry.filename);
				await writeFile(rawDiskPath, rawContent);

				// Handle processed file
				let processedDiskPath: string | null = null;
				if (fileEntry.processedPath) {
					const processedZipPath = `resources/${oldResourceId}/${fileEntry.processedPath}`;
					const processedContent = await readZipBinary(zip, processedZipPath);
					if (processedContent) {
						const processedDir = join(newResourceDir, "processed");
						await ensureDir(processedDir);
						const processedFilename =
							fileEntry.processedPath.split("/").pop() ?? fileEntry.processedPath;
						processedDiskPath = join(processedDir, processedFilename);
						await writeFile(processedDiskPath, processedContent);
					} else {
						log.warn(`importSession — missing processed file ${processedZipPath}`);
					}
				}

				const file = await db.file.create({
					data: {
						resourceId: resource.id,
						filename: fileEntry.filename,
						role: fileEntry.role,
						rawPath: rawDiskPath,
						processedPath: processedDiskPath,
						pageCount: fileEntry.pageCount ?? null,
						fileSize: fileEntry.fileSize ?? null,
					},
				});
				fileMap.set(fileEntry.id, file.id);
				stats.fileCount++;
			}

			// 4b. Copy tree/ directory
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

			// 4c. Create chunks sorted by depth then index (parents before children)
			const sortedChunks = [...resourceData.chunks].sort((a, b) => {
				if (a.depth !== b.depth) return a.depth - b.depth;
				return a.index - b.index;
			});

			for (const chunkEntry of sortedChunks) {
				// Remap references
				const newSourceFileId = chunkEntry.sourceFileId
					? (fileMap.get(chunkEntry.sourceFileId) ?? null)
					: null;
				const newParentId = chunkEntry.parentId
					? (chunkMap.get(chunkEntry.parentId) ?? null)
					: null;

				// diskPath is stored as relative (e.g. "tree/slug/01-intro.md") — keep as-is
				const newDiskPath = chunkEntry.diskPath ?? null;

				const chunk = await db.chunk.create({
					data: {
						resourceId: resource.id,
						sourceFileId: newSourceFileId,
						parentId: newParentId,
						index: chunkEntry.index,
						depth: chunkEntry.depth,
						nodeType: chunkEntry.nodeType,
						slug: chunkEntry.slug ?? null,
						diskPath: newDiskPath,
						title: chunkEntry.title ?? null,
						content: chunkEntry.content,
						startPage: chunkEntry.startPage ?? null,
						endPage: chunkEntry.endPage ?? null,
						keywords: chunkEntry.keywords ?? null,
					},
				});
				chunkMap.set(chunkEntry.id, chunk.id);
				stats.chunkCount++;
			}

			log.debug(
				`importSession — imported resource "${resourceData.name}" (${resourceData.files.length} files, ${resourceData.chunks.length} chunks)`,
			);
		}

		// 5. Import concepts
		const conceptsFile = zip.file("concepts.json");
		if (conceptsFile) {
			const rawConcepts = JSON.parse(await conceptsFile.async("string"));
			const concepts = conceptExportSchema.array().parse(rawConcepts);

			for (const conceptEntry of concepts) {
				const concept = await db.concept.create({
					data: {
						sessionId: session.id,
						name: conceptEntry.name,
						description: conceptEntry.description ?? null,
						aliases: conceptEntry.aliases ?? null,
						createdBy: conceptEntry.createdBy,
					},
				});
				conceptMap.set(conceptEntry.id, concept.id);
				stats.conceptCount++;
			}

			log.debug(`importSession — imported ${stats.conceptCount} concepts`);
		}

		// 6. Import relationships
		const relationshipsFile = zip.file("relationships.json");
		if (relationshipsFile) {
			const rawRelationships = JSON.parse(await relationshipsFile.async("string"));
			const relationships = relationshipExportSchema.array().parse(rawRelationships);

			for (const relEntry of relationships) {
				// Remap sourceId based on sourceType
				const newSourceId = remapEntityId(
					relEntry.sourceType,
					relEntry.sourceId,
					resourceMap,
					chunkMap,
					conceptMap,
				);
				if (!newSourceId) {
					log.warn(
						`importSession — skipping relationship: missing ${relEntry.sourceType} source ${relEntry.sourceId}`,
					);
					continue;
				}

				// Remap targetId based on targetType
				const newTargetId = remapEntityId(
					relEntry.targetType,
					relEntry.targetId,
					resourceMap,
					chunkMap,
					conceptMap,
				);
				if (!newTargetId) {
					log.warn(
						`importSession — skipping relationship: missing ${relEntry.targetType} target ${relEntry.targetId}`,
					);
					continue;
				}

				await db.relationship.create({
					data: {
						sessionId: session.id,
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

		// 7. Import conversations
		for (const oldConvId of manifest.conversationIds) {
			const convPath = `conversations/${oldConvId}.json`;
			let rawConv: unknown;
			try {
				rawConv = await readZipJson(zip, convPath);
			} catch {
				log.warn(`importSession — missing ${convPath}, skipping conversation`);
				continue;
			}

			const convData = conversationExportSchema.parse(rawConv);

			const conversation = await db.conversation.create({
				data: {
					sessionId: session.id,
					title: convData.title,
				},
			});
			conversationMap.set(oldConvId, conversation.id);
			stats.conversationCount++;

			// Create messages in order
			for (const msgEntry of convData.messages) {
				const message = await db.message.create({
					data: {
						conversationId: conversation.id,
						role: msgEntry.role,
						content: msgEntry.content,
						toolCalls: msgEntry.toolCalls ?? null,
					},
				});
				messageMap.set(msgEntry.id, message.id);
				stats.messageCount++;

				// Handle attachments for this message
				if (msgEntry.attachments && msgEntry.attachments.length > 0) {
					for (const attEntry of msgEntry.attachments) {
						const ext = extname(attEntry.filename) || ".bin";
						const attachmentZipPath = `attachments/${attEntry.id}${ext}`;
						const attachmentContent = await readZipBinary(zip, attachmentZipPath);

						if (!attachmentContent) {
							log.warn(`importSession — missing attachment ${attachmentZipPath}, skipping`);
							continue;
						}

						// Save to chat-attachments directory
						const attachmentsDir = getAttachmentsDir();
						await ensureDir(attachmentsDir);

						// Generate a new filename for the attachment on disk
						const newAttachmentFilename = `${message.id}-${attEntry.filename}`;
						const attachmentDiskPath = join(attachmentsDir, newAttachmentFilename);
						await writeFile(attachmentDiskPath, attachmentContent);

						await db.chatAttachment.create({
							data: {
								messageId: message.id,
								filename: attEntry.filename,
								contentType: attEntry.contentType,
								diskPath: attachmentDiskPath,
								fileSize: attEntry.fileSize,
							},
						});
						stats.attachmentCount++;
					}
				}
			}

			log.debug(
				`importSession — imported conversation "${convData.title}" (${convData.messages.length} messages)`,
			);
		}

		log.info(
			`importSession — completed: ${stats.resourceCount} resources, ${stats.fileCount} files, ${stats.chunkCount} chunks, ${stats.conceptCount} concepts, ${stats.relationshipCount} relationships, ${stats.conversationCount} conversations, ${stats.messageCount} messages, ${stats.attachmentCount} attachments`,
		);

		return stats;
	} catch (error) {
		// Attempt cleanup on critical error
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

/**
 * Remap an entity ID based on its type using the appropriate map.
 * Returns null if the entity cannot be found in the map.
 */
function remapEntityId(
	entityType: string,
	oldId: string,
	resourceMap: Map<string, string>,
	chunkMap: Map<string, string>,
	conceptMap: Map<string, string>,
): string | null {
	switch (entityType) {
		case "resource":
			return resourceMap.get(oldId) ?? null;
		case "chunk":
			return chunkMap.get(oldId) ?? null;
		case "concept":
			return conceptMap.get(oldId) ?? null;
		default:
			log.warn(`importSession — unknown entity type "${entityType}" for ID ${oldId}`);
			return null;
	}
}
