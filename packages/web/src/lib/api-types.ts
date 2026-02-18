export interface SessionSummary {
	id: string;
	name: string;
	module: string | null;
	examDate: string | null;
	resourceCount: number;
	scope: string | null;
}

export interface ResourceFile {
	id: string;
	filename: string;
	role: string;
	fileSize: number | null;
}

export interface Resource {
	id: string;
	name: string;
	type: string;
	label: string | null;
	isIndexed: boolean;
	isGraphIndexed: boolean;
	graphIndexDurationMs: number | null;
	files: ResourceFile[];
}

export type GraphThoroughness = "quick" | "standard" | "thorough";

export interface Session {
	id: string;
	name: string;
	module: string | null;
	examDate: string | null;
	scope: string | null;
	notes: string | null;
	graphThoroughness: GraphThoroughness;
	resources: Resource[];
}

export interface Concept {
	id: string;
	name: string;
	description: string | null;
	aliases: string | null;
	createdBy: string;
}

export interface Relationship {
	id: string;
	sourceType: string;
	sourceId: string;
	sourceLabel: string | null;
	targetType: string;
	targetId: string;
	targetLabel: string | null;
	relationship: string;
	confidence: number;
}

export interface GraphResource {
	id: string;
	name: string;
	type: string;
	label: string | null;
}

export interface SessionGraph {
	concepts: Concept[];
	relationships: Relationship[];
	resources: GraphResource[];
	chunkResourceMap: Record<string, string>;
}

export interface BatchResource {
	id: string;
	name: string;
	type: string;
	phase: 1 | 2;
	status: "pending" | "indexing" | "completed" | "cancelled" | "failed";
	durationMs: number | null;
	errorMessage: string | null;
	errorType: string | null;
	attempts: number;
}

export interface PhaseInfo {
	current: 1 | 2 | 3 | 4 | 5 | null;
	phase1: { total: number; completed: number; failed: number; mode: "sequential" };
	phase2: {
		total: number;
		completed: number;
		failed: number;
		running: number;
		mode: "parallel";
		concurrency: number;
	};
	phase3: {
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		error?: string;
		linksAdded?: number;
	};
	phase4: {
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		error?: string;
		stats?: {
			duplicatesRemoved: number;
			orphansRemoved: number;
			integrityFixes: number;
			conceptsMerged: number;
		};
	};
	phase5: {
		status: "pending" | "running" | "completed" | "failed" | "skipped";
		total?: number;
		completed?: number;
		failed?: number;
	};
}

export interface BatchStatus {
	batchTotal: number;
	batchCompleted: number;
	batchFailed: number;
	currentResourceId: string | null;
	startedAt: number;
	cancelled: boolean;
	phase: PhaseInfo;
	resources: BatchResource[];
}

export interface IndexStatus {
	total: number;
	indexed: number;
	inProgress: number;
	avgDurationMs: number | null;
	batch: BatchStatus | null;
}

export interface ResourceContent {
	id: string;
	name: string;
	type: string;
	content: string;
}

export interface ConversationSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface ChatAttachment {
	id: string;
	filename: string;
	contentType: string;
}

export interface ToolCallData {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	toolCalls?: string | null;
	createdAt: string;
	attachments?: ChatAttachment[];
}

export interface StreamStatus {
	active: boolean;
	status: "streaming" | "complete" | "error" | null;
}

export interface GraphLogEntry {
	id: string;
	sessionId: string;
	source: string;
	action: string;
	resourceId: string | null;
	conversationId: string | null;
	conceptsCreated: number;
	conceptsUpdated: number;
	relationshipsCreated: number;
	durationMs: number | null;
	details: string | null;
	createdAt: string;
}

export interface ImportResult {
	sessionId: string;
	stats: {
		resourceCount: number;
		fileCount: number;
		chunkCount: number;
		conceptCount: number;
		relationshipCount: number;
		conversationCount: number;
		messageCount: number;
	};
}
