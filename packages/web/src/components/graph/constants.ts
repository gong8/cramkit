import type { GraphResource } from "@/lib/api.js";
import type { GraphEdge, GraphNode, LayoutTypes } from "reagraph";
import { lightTheme } from "reagraph";

// ─── Types ───────────────────────────────────────────────────────

export interface FullGraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	nodeTypes: string[];
	relTypes: string[];
	resources: GraphResource[];
	resourcesByType: Map<string, GraphResource[]>;
}

export interface GraphStats {
	nodesByType: Record<string, number>;
	edgesByType: Record<string, number>;
	totalNodes: number;
	totalEdges: number;
	avgConfidence: number;
	orphanIds: string[];
}

export interface NodeDetailData {
	node: GraphNode;
	connections: ConnectionInfo[];
}

export interface ConnectionInfo {
	edgeId: string;
	direction: "outgoing" | "incoming";
	relationship: string;
	confidence: number;
	otherNodeId: string;
	otherNodeLabel: string;
	otherNodeType: string;
	otherNodeColor: string;
}

// ─── Constants ───────────────────────────────────────────────────

export const NODE_COLORS: Record<string, string> = {
	concept: "#7c3aed",
	resource: "#2563eb",
	chunk: "#059669",
	question: "#d97706",
};

export const EDGE_COLORS: Record<string, string> = {
	prerequisite: "#ef4444",
	covers: "#3b82f6",
	introduces: "#10b981",
	applies: "#f59e0b",
	references: "#8b5cf6",
	proves: "#6366f1",
	related_to: "#6b7280",
	extends: "#14b8a6",
	generalizes: "#0ea5e9",
	special_case_of: "#f97316",
	contradicts: "#dc2626",
	tests: "#a855f7",
	requires: "#e11d48",
};

export const GRAPH_THEME = {
	...lightTheme,
	node: {
		...lightTheme.node,
		inactiveOpacity: 0.05,
	},
	edge: {
		...lightTheme.edge,
		inactiveOpacity: 0.02,
	},
};

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	PROBLEM_SHEET: "Problem Sheet",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

export const RESOURCE_TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "#3b82f6",
	PAST_PAPER: "#f59e0b",
	PROBLEM_SHEET: "#a855f7",
	SPECIFICATION: "#6b7280",
	OTHER: "#6b7280",
};

export const LAYOUT_OPTIONS: { value: LayoutTypes; label: string }[] = [
	{ value: "forceDirected2d", label: "Force Directed" },
	{ value: "circular2d", label: "Circular" },
	{ value: "radialOut2d", label: "Radial" },
	{ value: "nooverlap", label: "No Overlap" },
];
