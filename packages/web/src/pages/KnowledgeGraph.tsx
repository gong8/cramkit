import { fetchSession, fetchSessionGraph } from "@/lib/api";
import type { Concept, Relationship } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { GraphCanvas, type GraphEdge, type GraphNode } from "reagraph";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";

const NODE_COLORS: Record<string, string> = {
	concept: "#7c3aed",
	file: "#2563eb",
	chunk: "#059669",
	question: "#d97706",
};

const EDGE_COLORS: Record<string, string> = {
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

function buildGraphData(concepts: Concept[], relationships: Relationship[]) {
	const nodeMap = new Map<string, GraphNode>();

	// Add concept nodes
	for (const c of concepts) {
		nodeMap.set(`concept:${c.id}`, {
			id: `concept:${c.id}`,
			label: c.name,
			fill: NODE_COLORS.concept,
			data: { type: "concept", description: c.description, aliases: c.aliases },
		});
	}

	// Add nodes from relationships that reference non-concept entities (files, chunks, questions)
	for (const r of relationships) {
		const sourceKey = `${r.sourceType}:${r.sourceId}`;
		if (!nodeMap.has(sourceKey)) {
			nodeMap.set(sourceKey, {
				id: sourceKey,
				label: r.sourceLabel || r.sourceId.slice(0, 8),
				fill: NODE_COLORS[r.sourceType] || "#6b7280",
				data: { type: r.sourceType },
			});
		}

		const targetKey = `${r.targetType}:${r.targetId}`;
		if (!nodeMap.has(targetKey)) {
			nodeMap.set(targetKey, {
				id: targetKey,
				label: r.targetLabel || r.targetId.slice(0, 8),
				fill: NODE_COLORS[r.targetType] || "#6b7280",
				data: { type: r.targetType },
			});
		}
	}

	// Build edges
	const edges: GraphEdge[] = relationships.map((r) => ({
		id: r.id,
		source: `${r.sourceType}:${r.sourceId}`,
		target: `${r.targetType}:${r.targetId}`,
		label: r.relationship.replace(/_/g, " "),
		fill: EDGE_COLORS[r.relationship] || "#9ca3af",
		size: Math.max(1, r.confidence * 3),
	}));

	return { nodes: Array.from(nodeMap.values()), edges };
}

export function KnowledgeGraph() {
	const { id } = useParams<{ id: string }>();
	const sessionId = id as string;

	const { data: session } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
	});

	const {
		data: graph,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["session-graph", sessionId],
		queryFn: () => fetchSessionGraph(sessionId),
		enabled: !!sessionId,
	});

	const graphData = graph ? buildGraphData(graph.concepts, graph.relationships) : null;

	return (
		<div className="flex h-screen flex-col">
			<div className="flex items-center gap-3 border-b border-border px-4 py-3">
				<Link
					to={`/session/${sessionId}`}
					className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="h-4 w-4" />
					Back
				</Link>
				<div className="h-4 w-px bg-border" />
				<h1 className="text-sm font-semibold">{session?.name ?? "Session"} — Knowledge Graph</h1>
				{graphData && (
					<span className="text-xs text-muted-foreground">
						{graphData.nodes.length} nodes, {graphData.edges.length} edges
					</span>
				)}
			</div>

			<div className="relative flex-1">
				{isLoading && (
					<div className="flex h-full items-center justify-center text-muted-foreground">Loading graph...</div>
				)}

				{error && (
					<div className="flex h-full items-center justify-center text-destructive">
						Failed to load graph data.
					</div>
				)}

				{graphData && graphData.nodes.length === 0 && (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
						<p className="text-lg font-medium">No graph data yet</p>
						<p className="text-sm">Index some files first to see the knowledge graph.</p>
					</div>
				)}

				{graphData && graphData.nodes.length > 0 && (
					<GraphCanvas
						nodes={graphData.nodes}
						edges={graphData.edges}
						layoutType="forceDirected2d"
						edgeArrowPosition="end"
						labelType="all"
						draggable
					/>
				)}
			</div>

			{graphData && graphData.nodes.length > 0 && (
				<div className="flex gap-4 border-t border-border px-4 py-2">
					{Object.entries(NODE_COLORS).map(([type, color]) => (
						<div key={type} className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
							{type}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
