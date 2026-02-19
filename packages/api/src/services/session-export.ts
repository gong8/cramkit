import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createLogger, getDb } from "@cramkit/shared";
import type { ExportManifest, ResourceExport } from "@cramkit/shared";
import type { Prisma } from "@prisma/client";
import archiver from "archiver";
import { getResourceDir } from "./storage.js";

const log = createLogger("export");

// --- Prisma-derived types for the session export query ---

const sessionInclude = {
	resources: {
		include: {
			files: true,
			chunks: { orderBy: { index: "asc" } },
			paperQuestions: { orderBy: { questionNumber: "asc" } },
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
} satisfies Prisma.SessionInclude;

type FullSession = Prisma.SessionGetPayload<{ include: typeof sessionInclude }>;
type FullResource = FullSession["resources"][number];
type FullConversation = FullSession["conversations"][number];
type FullMessage = FullConversation["messages"][number];

// --- Utilities ---

function sumBy<T>(arr: T[], fn: (item: T) => number): number {
	return arr.reduce((sum, item) => sum + fn(item), 0);
}

function pick<T, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
	const result = {} as Pick<T, K>;
	for (const key of keys) {
		result[key] = obj[key];
	}
	return result;
}

// --- Field lists for pick() ---

const CONCEPT_FIELDS = [
	"id",
	"name",
	"description",
	"aliases",
	"content",
	"contentType",
	"metadata",
	"createdBy",
] as const;

const RELATIONSHIP_FIELDS = [
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
] as const;

const PAPER_QUESTION_FIELDS = [
	"id",
	"resourceId",
	"chunkId",
	"questionNumber",
	"parentNumber",
	"marks",
	"questionType",
	"commandWords",
	"content",
	"markSchemeText",
	"solutionText",
	"metadata",
] as const;

const CHUNK_FIELDS = [
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
	"metadata",
] as const;

// --- Main export ---

/**
 * Export a session as a zip archive buffer.
 * Includes all resources (files, chunks, tree), concepts, relationships,
 * conversations (messages + attachments), and a human-readable README.
 */
export async function exportSession(sessionId: string): Promise<Buffer> {
	const db = getDb();

	const session = await db.session.findUnique({
		where: { id: sessionId },
		include: sessionInclude,
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

// --- Mappers ---

function mapConcept(c: FullSession["concepts"][number]) {
	return pick(c, [...CONCEPT_FIELDS]);
}

function mapRelationship(r: FullSession["relationships"][number]) {
	return pick(r, [...RELATIONSHIP_FIELDS]);
}

function mapResourceExport(resource: FullResource): ResourceExport {
	return {
		...pick(resource, [
			"id",
			"name",
			"label",
			"splitMode",
			"isIndexed",
			"isGraphIndexed",
			"metadata",
			"isMetaIndexed",
			"metaIndexDurationMs",
		]),
		type: resource.type as ResourceExport["type"],
		files: resource.files.map((f) => ({
			...pick(f, ["id", "filename", "pageCount", "fileSize"]),
			role: f.role as "PRIMARY" | "MARK_SCHEME" | "SOLUTIONS" | "SUPPLEMENT",
			rawPath: `raw/${f.filename}`,
			processedPath: f.processedPath ? `processed/${basename(f.processedPath)}` : null,
		})),
		chunks: resource.chunks.map((c) => pick(c, [...CHUNK_FIELDS])),
	};
}

function mapMessage(m: FullMessage) {
	return {
		...pick(m, ["id", "role", "content", "toolCalls"]),
		attachments: m.attachments
			.filter((a) => a.messageId !== null)
			.map((a) => pick(a, ["id", "filename", "contentType", "fileSize"])),
	};
}

// --- Archive helpers ---

function appendJson(archive: archiver.Archiver, data: unknown, zipPath: string): void {
	archive.append(JSON.stringify(data, null, 2), { name: zipPath });
}

async function addResourcesToArchive(
	archive: archiver.Archiver,
	sessionId: string,
	resources: FullResource[],
): Promise<void> {
	for (const resource of resources) {
		const prefix = `resources/${resource.id}`;
		const resourceDir = getResourceDir(sessionId, resource.id);

		appendJson(archive, mapResourceExport(resource), `${prefix}/resource.json`);

		if (resource.paperQuestions.length > 0) {
			appendJson(
				archive,
				resource.paperQuestions.map((q) => pick(q, [...PAPER_QUESTION_FIELDS])),
				`${prefix}/questions.json`,
			);
		}

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

async function addConversationsToArchive(
	archive: archiver.Archiver,
	conversations: FullConversation[],
): Promise<void> {
	for (const conv of conversations) {
		appendJson(
			archive,
			{ id: conv.id, title: conv.title, messages: conv.messages.map(mapMessage) },
			`conversations/${conv.id}.json`,
		);

		const attachments = conv.messages.flatMap((m) =>
			m.attachments.filter((a) => a.messageId !== null),
		);
		for (const att of attachments) {
			const ext = att.filename.split(".").pop() ?? "bin";
			await appendFileIfExists(archive, att.diskPath, `attachments/${att.id}.${ext}`);
		}
	}
}

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

function buildManifest(session: FullSession): ExportManifest {
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
		resourceIds: session.resources.map((r) => r.id),
		conversationIds: session.conversations.map((c) => c.id),
		stats: {
			resourceCount: session.resources.length,
			fileCount: sumBy(session.resources, (r) => r.files.length),
			chunkCount: sumBy(session.resources, (r) => r.chunks.length),
			conceptCount: session.concepts.length,
			relationshipCount: session.relationships.length,
			conversationCount: session.conversations.length,
			messageCount: sumBy(session.conversations, (c) => c.messages.length),
		},
	};
}

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
