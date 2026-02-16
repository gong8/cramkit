import { fetchSession, fetchSessionGraph } from "@/lib/api";
import type { Concept, GraphResource, Relationship } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { GraphCanvas, type GraphCanvasRef, type GraphEdge, type GraphNode, type LayoutTypes } from "reagraph";
import { ArrowLeft, ArrowRight, Search, X } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useCallback, useMemo, useRef, useState } from "react";

// ─── Constants ──────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
	concept: "#7c3aed",
	resource: "#2563eb",
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

const RESOURCE_TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	PROBLEM_SHEET: "Problem Sheet",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

const RESOURCE_TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "#3b82f6",
	PAST_PAPER: "#f59e0b",
	PROBLEM_SHEET: "#a855f7",
	SPECIFICATION: "#6b7280",
	OTHER: "#6b7280",
};

const LAYOUT_OPTIONS: { value: LayoutTypes; label: string }[] = [
	{ value: "forceDirected2d", label: "Force Directed" },
	{ value: "circular2d", label: "Circular" },
	{ value: "hierarchicalTd", label: "Hierarchical" },
	{ value: "treeTd2d", label: "Tree (Top-Down)" },
	{ value: "treeLr2d", label: "Tree (Left-Right)" },
	{ value: "radialOut2d", label: "Radial" },
	{ value: "nooverlap", label: "No Overlap" },
];

// ─── Data Building ──────────────────────────────────────────────

interface FullGraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	nodeTypes: string[];
	relTypes: string[];
	resources: GraphResource[];
	resourcesByType: Map<string, GraphResource[]>;
}

function buildGraphData(concepts: Concept[], relationships: Relationship[], resources: GraphResource[]): FullGraphData {
	const nodeMap = new Map<string, GraphNode>();
	const nodeTypeSet = new Set<string>();
	const relTypeSet = new Set<string>();

	// Build a lookup for resource metadata
	const resourceMap = new Map<string, GraphResource>();
	for (const r of resources) {
		resourceMap.set(r.id, r);
	}

	for (const c of concepts) {
		nodeTypeSet.add("concept");
		nodeMap.set(`concept:${c.id}`, {
			id: `concept:${c.id}`,
			label: c.name,
			fill: NODE_COLORS.concept,
			data: { type: "concept", description: c.description, aliases: c.aliases },
		});
	}

	for (const r of relationships) {
		relTypeSet.add(r.relationship);

		const sourceKey = `${r.sourceType}:${r.sourceId}`;
		if (!nodeMap.has(sourceKey)) {
			nodeTypeSet.add(r.sourceType);
			const resMeta = r.sourceType === "resource" ? resourceMap.get(r.sourceId) : undefined;
			nodeMap.set(sourceKey, {
				id: sourceKey,
				label: resMeta?.name || r.sourceLabel || r.sourceId.slice(0, 8),
				fill: (resMeta && RESOURCE_TYPE_COLORS[resMeta.type]) || NODE_COLORS[r.sourceType] || "#6b7280",
				data: {
					type: r.sourceType,
					resourceId: r.sourceType === "resource" ? r.sourceId : undefined,
					resourceType: resMeta?.type,
				},
			});
		}

		const targetKey = `${r.targetType}:${r.targetId}`;
		if (!nodeMap.has(targetKey)) {
			nodeTypeSet.add(r.targetType);
			const resMeta = r.targetType === "resource" ? resourceMap.get(r.targetId) : undefined;
			nodeMap.set(targetKey, {
				id: targetKey,
				label: resMeta?.name || r.targetLabel || r.targetId.slice(0, 8),
				fill: (resMeta && RESOURCE_TYPE_COLORS[resMeta.type]) || NODE_COLORS[r.targetType] || "#6b7280",
				data: {
					type: r.targetType,
					resourceId: r.targetType === "resource" ? r.targetId : undefined,
					resourceType: resMeta?.type,
				},
			});
		}
	}

	const edges: GraphEdge[] = relationships.map((r) => ({
		id: r.id,
		source: `${r.sourceType}:${r.sourceId}`,
		target: `${r.targetType}:${r.targetId}`,
		label: r.relationship.replace(/_/g, " "),
		fill: EDGE_COLORS[r.relationship] || "#9ca3af",
		size: Math.max(1, r.confidence * 3),
		data: { relationship: r.relationship, confidence: r.confidence },
	}));

	// Group resources by type for the sidebar
	const resourcesByType = new Map<string, GraphResource[]>();
	for (const r of resources) {
		const list = resourcesByType.get(r.type) || [];
		list.push(r);
		resourcesByType.set(r.type, list);
	}

	return {
		nodes: Array.from(nodeMap.values()),
		edges,
		nodeTypes: Array.from(nodeTypeSet).sort(),
		relTypes: Array.from(relTypeSet).sort(),
		resources,
		resourcesByType,
	};
}

// ─── Pathfinding (BFS) ─────────────────────────────────────────

function findPath(
	edges: GraphEdge[],
	fromId: string,
	toId: string,
): { nodeIds: string[]; edgeIds: string[] } | null {
	const adj = new Map<string, { nodeId: string; edgeId: string }[]>();
	for (const edge of edges) {
		if (!adj.has(edge.source)) adj.set(edge.source, []);
		if (!adj.has(edge.target)) adj.set(edge.target, []);
		adj.get(edge.source)!.push({ nodeId: edge.target, edgeId: edge.id });
		adj.get(edge.target)!.push({ nodeId: edge.source, edgeId: edge.id });
	}

	const visited = new Set<string>([fromId]);
	const queue: { nodeId: string; path: string[]; edgePath: string[] }[] = [
		{ nodeId: fromId, path: [fromId], edgePath: [] },
	];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.nodeId === toId) return { nodeIds: current.path, edgeIds: current.edgePath };

		for (const neighbor of adj.get(current.nodeId) || []) {
			if (!visited.has(neighbor.nodeId)) {
				visited.add(neighbor.nodeId);
				queue.push({
					nodeId: neighbor.nodeId,
					path: [...current.path, neighbor.nodeId],
					edgePath: [...current.edgePath, neighbor.edgeId],
				});
			}
		}
	}

	return null;
}

// ─── Stats ──────────────────────────────────────────────────────

interface GraphStats {
	nodesByType: Record<string, number>;
	edgesByType: Record<string, number>;
	totalNodes: number;
	totalEdges: number;
	avgConfidence: number;
	orphanIds: string[];
}

function computeStats(nodes: GraphNode[], edges: GraphEdge[]): GraphStats {
	const nodesByType: Record<string, number> = {};
	for (const node of nodes) {
		const type = node.data?.type || "unknown";
		nodesByType[type] = (nodesByType[type] || 0) + 1;
	}

	const edgesByType: Record<string, number> = {};
	let totalConfidence = 0;
	for (const edge of edges) {
		const type = edge.data?.relationship || "unknown";
		edgesByType[type] = (edgesByType[type] || 0) + 1;
		totalConfidence += edge.data?.confidence || 0;
	}

	const connectedNodes = new Set<string>();
	for (const edge of edges) {
		connectedNodes.add(edge.source);
		connectedNodes.add(edge.target);
	}

	return {
		nodesByType,
		edgesByType,
		totalNodes: nodes.length,
		totalEdges: edges.length,
		avgConfidence: edges.length > 0 ? totalConfidence / edges.length : 0,
		orphanIds: nodes.filter((n) => !connectedNodes.has(n.id)).map((n) => n.id),
	};
}

// ─── Node Picker (for pathfinding) ─────────────────────────────

function NodePicker({
	nodes,
	value,
	onChange,
	placeholder,
}: {
	nodes: GraphNode[];
	value: string | null;
	onChange: (id: string | null) => void;
	placeholder: string;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const selected = nodes.find((n) => n.id === value);

	const filtered = useMemo(
		() =>
			query
				? nodes.filter((n) => (n.label ?? "").toLowerCase().includes(query.toLowerCase())).slice(0, 8)
				: nodes.slice(0, 8),
		[nodes, query],
	);

	return (
		<div className="relative">
			<input
				type="text"
				value={selected ? selected.label : query}
				onChange={(e) => {
					setQuery(e.target.value);
					setOpen(true);
					if (value) onChange(null);
				}}
				onFocus={() => {
					if (value) {
						onChange(null);
						setQuery("");
					}
					setOpen(true);
				}}
				onBlur={() => setTimeout(() => setOpen(false), 200)}
				placeholder={placeholder}
				className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
			/>
			{open && filtered.length > 0 && (
				<div className="absolute z-50 mt-1 max-h-32 w-full overflow-y-auto rounded border border-border bg-background shadow-lg">
					{filtered.map((n) => (
						<button
							key={n.id}
							className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent"
							onMouseDown={(e) => {
								e.preventDefault();
								onChange(n.id);
								setQuery("");
								setOpen(false);
							}}
						>
							<span
								className="h-2 w-2 shrink-0 rounded-full"
								style={{ backgroundColor: n.fill || "#6b7280" }}
							/>
							<span className="truncate">{n.label}</span>
						</button>
					))}
				</div>
			)}
			{value && (
				<button
					className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					onClick={() => {
						onChange(null);
						setQuery("");
					}}
				>
					<X className="h-3 w-3" />
				</button>
			)}
		</div>
	);
}

// ─── Main Component ─────────────────────────────────────────────

export function KnowledgeGraph() {
	const { id } = useParams<{ id: string }>();
	const sessionId = id as string;
	const graphRef = useRef<GraphCanvasRef>(null);

	// Data
	const { data: session } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
	});

	const { data: graph, isLoading, error } = useQuery({
		queryKey: ["session-graph", sessionId],
		queryFn: () => fetchSessionGraph(sessionId),
		enabled: !!sessionId,
	});

	// UI state
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [disabledNodeTypes, setDisabledNodeTypes] = useState<Set<string>>(new Set());
	const [disabledRelTypes, setDisabledRelTypes] = useState<Set<string>>(new Set());
	const [disabledResourceIds, setDisabledResourceIds] = useState<Set<string>>(new Set());
	const [confidenceThreshold, setConfidenceThreshold] = useState(0);
	const [layoutType, setLayoutType] = useState<LayoutTypes>("forceDirected2d");
	const [pathFrom, setPathFrom] = useState<string | null>(null);
	const [pathTo, setPathTo] = useState<string | null>(null);
	const [pathResult, setPathResult] = useState<{ nodeIds: string[]; edgeIds: string[] } | null>(null);
	const [pathSearched, setPathSearched] = useState(false);
	const [highlightOrphans, setHighlightOrphans] = useState(false);

	// Full graph (unfiltered)
	const fullGraph = useMemo(
		() => (graph ? buildGraphData(graph.concepts, graph.relationships, graph.resources) : null),
		[graph],
	);

	// Stats (from full graph)
	const stats = useMemo(() => (fullGraph ? computeStats(fullGraph.nodes, fullGraph.edges) : null), [fullGraph]);

	// Filtered graph
	const filteredGraph = useMemo(() => {
		if (!fullGraph) return null;

		const filteredNodeIds = new Set<string>();
		for (const node of fullGraph.nodes) {
			if (disabledNodeTypes.has(node.data?.type)) continue;
			// Hide individual file nodes that are disabled
			if (node.data?.type === "resource" && node.data?.resourceId && disabledResourceIds.has(node.data.resourceId)) continue;
			filteredNodeIds.add(node.id);
		}

		const visibleEdges = fullGraph.edges.filter((e) => {
			if (disabledRelTypes.has(e.data?.relationship)) return false;
			if ((e.data?.confidence || 0) < confidenceThreshold) return false;
			if (!filteredNodeIds.has(e.source) || !filteredNodeIds.has(e.target)) return false;
			return true;
		});

		const visibleNodes = fullGraph.nodes.filter((n) => filteredNodeIds.has(n.id));
		return { nodes: visibleNodes, edges: visibleEdges };
	}, [fullGraph, disabledNodeTypes, disabledRelTypes, disabledResourceIds, confidenceThreshold]);

	// Search results
	const searchResults = useMemo(() => {
		if (!fullGraph || !searchQuery.trim()) return [];
		const q = searchQuery.toLowerCase();
		return fullGraph.nodes.filter((n) => (n.label ?? "").toLowerCase().includes(q)).slice(0, 10);
	}, [fullGraph, searchQuery]);

	// Selections (reagraph highlight)
	const selections = useMemo(() => {
		const ids: string[] = [];
		if (selectedNodeId) ids.push(selectedNodeId);
		if (pathResult) ids.push(...pathResult.nodeIds, ...pathResult.edgeIds);
		if (highlightOrphans && stats) ids.push(...stats.orphanIds);
		return ids;
	}, [selectedNodeId, pathResult, highlightOrphans, stats]);

	// Detail panel data
	const selectedNodeDetail = useMemo(() => {
		if (!selectedNodeId || !fullGraph) return null;
		const node = fullGraph.nodes.find((n) => n.id === selectedNodeId);
		if (!node) return null;

		const connections = fullGraph.edges
			.filter((e) => e.source === selectedNodeId || e.target === selectedNodeId)
			.map((e) => {
				const isSource = e.source === selectedNodeId;
				const otherNodeId = isSource ? e.target : e.source;
				const otherNode = fullGraph.nodes.find((n) => n.id === otherNodeId);
				return {
					edgeId: e.id,
					direction: isSource ? ("outgoing" as const) : ("incoming" as const),
					relationship: (e.data?.relationship as string) || "unknown",
					confidence: (e.data?.confidence as number) || 0,
					otherNodeId,
					otherNodeLabel: otherNode?.label || otherNodeId,
					otherNodeType: (otherNode?.data?.type as string) || "unknown",
					otherNodeColor: otherNode?.fill || "#6b7280",
				};
			});

		return { node, connections };
	}, [selectedNodeId, fullGraph]);

	// Concept nodes only (for pathfinding)
	const conceptNodes = useMemo(
		() => fullGraph?.nodes.filter((n) => n.data?.type === "concept") || [],
		[fullGraph],
	);

	// Handlers
	const handleSearchSelect = useCallback((nodeId: string) => {
		setSelectedNodeId(nodeId);
		setSearchQuery("");
		setSearchOpen(false);
		graphRef.current?.centerGraph([nodeId]);
	}, []);

	const handleFindPath = useCallback(() => {
		if (!pathFrom || !pathTo || !fullGraph) return;
		const result = findPath(fullGraph.edges, pathFrom, pathTo);
		setPathResult(result);
		setPathSearched(true);
		if (result) {
			graphRef.current?.fitNodesInView(result.nodeIds);
		}
	}, [pathFrom, pathTo, fullGraph]);

	const handleClearPath = useCallback(() => {
		setPathFrom(null);
		setPathTo(null);
		setPathResult(null);
		setPathSearched(false);
	}, []);

	const toggleNodeType = useCallback((type: string) => {
		setDisabledNodeTypes((prev) => {
			const next = new Set(prev);
			if (next.has(type)) next.delete(type);
			else next.add(type);
			return next;
		});
	}, []);

	const toggleRelType = useCallback((type: string) => {
		setDisabledRelTypes((prev) => {
			const next = new Set(prev);
			if (next.has(type)) next.delete(type);
			else next.add(type);
			return next;
		});
	}, []);

	const toggleResource = useCallback((resourceId: string) => {
		setDisabledResourceIds((prev) => {
			const next = new Set(prev);
			if (next.has(resourceId)) next.delete(resourceId);
			else next.add(resourceId);
			return next;
		});
	}, []);

	const toggleResourceType = useCallback(
		(resourceType: string) => {
			if (!fullGraph) return;
			const resourcesOfType = fullGraph.resourcesByType.get(resourceType) || [];
			const ids = resourcesOfType.map((r) => r.id);
			setDisabledResourceIds((prev) => {
				const allDisabled = ids.every((id) => prev.has(id));
				const next = new Set(prev);
				for (const id of ids) {
					if (allDisabled) next.delete(id);
					else next.add(id);
				}
				return next;
			});
		},
		[fullGraph],
	);

	// Loading / error / empty
	if (isLoading) {
		return <div className="flex h-screen items-center justify-center text-muted-foreground">Loading graph...</div>;
	}
	if (error) {
		return (
			<div className="flex h-screen items-center justify-center text-destructive">Failed to load graph data.</div>
		);
	}
	if (!filteredGraph || !fullGraph || fullGraph.nodes.length === 0) {
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
				</div>
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
					<p className="text-lg font-medium">No graph data yet</p>
					<p className="text-sm">Index some resources first to see the knowledge graph.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-screen flex-col">
			{/* Header */}
			<div className="flex items-center gap-3 border-b border-border px-4 py-2">
				<Link
					to={`/session/${sessionId}`}
					className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="h-4 w-4" />
					Back
				</Link>
				<div className="h-4 w-px bg-border" />
				<h1 className="shrink-0 text-sm font-semibold">{session?.name ?? "Session"} — Knowledge Graph</h1>
				<span className="shrink-0 text-xs text-muted-foreground">
					{filteredGraph.nodes.length}/{fullGraph.nodes.length} nodes, {filteredGraph.edges.length}/
					{fullGraph.edges.length} edges
				</span>

				{/* Search */}
				<div className="relative ml-auto">
					<div className="flex items-center gap-1 rounded border border-input px-2 py-1">
						<Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => {
								setSearchQuery(e.target.value);
								setSearchOpen(true);
							}}
							onFocus={() => setSearchOpen(true)}
							onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
							placeholder="Search nodes..."
							className="w-48 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
						/>
						{searchQuery && (
							<button
								onClick={() => {
									setSearchQuery("");
									setSearchOpen(false);
								}}
							>
								<X className="h-3 w-3 text-muted-foreground" />
							</button>
						)}
					</div>
					{searchOpen && searchResults.length > 0 && (
						<div className="absolute right-0 z-50 mt-1 max-h-48 w-64 overflow-y-auto rounded border border-border bg-background shadow-lg">
							{searchResults.map((n) => (
								<button
									key={n.id}
									className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
									onMouseDown={(e) => {
										e.preventDefault();
										handleSearchSelect(n.id);
									}}
								>
									<span
										className="h-2 w-2 shrink-0 rounded-full"
										style={{ backgroundColor: n.fill || "#6b7280" }}
									/>
									<span className="truncate">{n.label}</span>
									<span className="ml-auto shrink-0 text-muted-foreground">{n.data?.type}</span>
								</button>
							))}
						</div>
					)}
				</div>

				{/* Layout switcher */}
				<select
					value={layoutType}
					onChange={(e) => setLayoutType(e.target.value as LayoutTypes)}
					className="shrink-0 rounded border border-input bg-background px-2 py-1 text-xs"
				>
					{LAYOUT_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			</div>

			{/* Main content */}
			<div className="flex flex-1 overflow-hidden">
				{/* Left sidebar */}
				<div className="w-64 shrink-0 overflow-y-auto border-r border-border">
					{/* Node type filters */}
					<div className="border-b border-border p-3">
						<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Node Types</h3>
						<div className="space-y-1">
							{fullGraph.nodeTypes.map((type) => (
								<label key={type} className="flex cursor-pointer items-center gap-2 text-xs">
									<input
										type="checkbox"
										checked={!disabledNodeTypes.has(type)}
										onChange={() => toggleNodeType(type)}
										className="rounded"
									/>
									<span
										className="h-2.5 w-2.5 rounded-full"
										style={{ backgroundColor: NODE_COLORS[type] || "#6b7280" }}
									/>
									<span>{type}</span>
									<span className="ml-auto text-muted-foreground">
										{stats?.nodesByType[type] || 0}
									</span>
								</label>
							))}
						</div>
					</div>

					{/* Resource filter (grouped by type) */}
					{fullGraph.resourcesByType.size > 0 && (
						<div className="border-b border-border p-3">
							<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
								Resources
							</h3>
							<div className="space-y-2">
								{Array.from(fullGraph.resourcesByType.entries()).map(([resType, typeResources]) => {
									const allDisabled = typeResources.every((r) => disabledResourceIds.has(r.id));
									const someDisabled =
										!allDisabled && typeResources.some((r) => disabledResourceIds.has(r.id));
									return (
										<div key={resType}>
											<label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
												<input
													type="checkbox"
													checked={!allDisabled}
													ref={(el) => {
														if (el) el.indeterminate = someDisabled;
													}}
													onChange={() => toggleResourceType(resType)}
													className="rounded"
												/>
												<span
													className="h-2 w-2 rounded-full"
													style={{
														backgroundColor:
															RESOURCE_TYPE_COLORS[resType] || "#6b7280",
													}}
												/>
												<span>
													{RESOURCE_TYPE_LABELS[resType] || resType}
												</span>
												<span className="ml-auto text-muted-foreground">
													{typeResources.length}
												</span>
											</label>
											<div className="ml-5 mt-1 space-y-0.5">
												{typeResources.map((r) => (
													<label
														key={r.id}
														className="flex cursor-pointer items-center gap-2 text-xs"
													>
														<input
															type="checkbox"
															checked={!disabledResourceIds.has(r.id)}
															onChange={() => toggleResource(r.id)}
															className="rounded"
														/>
														<span className="truncate text-muted-foreground">
															{r.label || r.name}
														</span>
													</label>
												))}
											</div>
										</div>
);
								})}
							</div>
						</div>
					)}

					{/* Relationship type filters */}
					<div className="border-b border-border p-3">
						<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Relationships</h3>
						<div className="space-y-1">
							{fullGraph.relTypes.map((type) => (
								<label key={type} className="flex cursor-pointer items-center gap-2 text-xs">
									<input
										type="checkbox"
										checked={!disabledRelTypes.has(type)}
										onChange={() => toggleRelType(type)}
										className="rounded"
									/>
									<span
										className="h-2 w-4 rounded-sm"
										style={{ backgroundColor: EDGE_COLORS[type] || "#9ca3af" }}
									/>
									<span>{type.replace(/_/g, " ")}</span>
									<span className="ml-auto text-muted-foreground">
										{stats?.edgesByType[type] || 0}
									</span>
								</label>
							))}
						</div>
					</div>

					{/* Confidence slider */}
					<div className="border-b border-border p-3">
						<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
							Min Confidence: {confidenceThreshold.toFixed(2)}
						</h3>
						<input
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={confidenceThreshold}
							onChange={(e) => setConfidenceThreshold(Number.parseFloat(e.target.value))}
							className="w-full accent-primary"
						/>
						<div className="mt-1 flex justify-between text-xs text-muted-foreground">
							<span>0</span>
							<span>1</span>
						</div>
					</div>

					{/* Stats */}
					<div className="border-b border-border p-3">
						<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Stats</h3>
						{stats && (
							<div className="space-y-1 text-xs">
								<div className="flex justify-between">
									<span>Total nodes</span>
									<span className="font-medium">{stats.totalNodes}</span>
								</div>
								<div className="flex justify-between">
									<span>Total edges</span>
									<span className="font-medium">{stats.totalEdges}</span>
								</div>
								<div className="flex justify-between">
									<span>Avg confidence</span>
									<span className="font-medium">{stats.avgConfidence.toFixed(2)}</span>
								</div>
								<div className="flex items-center justify-between">
									<label className="flex cursor-pointer items-center gap-1.5">
										<input
											type="checkbox"
											checked={highlightOrphans}
											onChange={(e) => setHighlightOrphans(e.target.checked)}
											className="rounded"
										/>
										<span>Orphan nodes</span>
									</label>
									<span
										className={`font-medium ${stats.orphanIds.length > 0 ? "text-amber-500" : ""}`}
									>
										{stats.orphanIds.length}
									</span>
								</div>
							</div>
						)}
					</div>

					{/* Pathfinding */}
					<div className="p-3">
						<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Find Path</h3>
						<div className="space-y-2">
							<NodePicker
								nodes={conceptNodes}
								value={pathFrom}
								onChange={(id) => {
									setPathFrom(id);
									setPathResult(null);
									setPathSearched(false);
								}}
								placeholder="From concept..."
							/>
							<NodePicker
								nodes={conceptNodes}
								value={pathTo}
								onChange={(id) => {
									setPathTo(id);
									setPathResult(null);
									setPathSearched(false);
								}}
								placeholder="To concept..."
							/>
							<div className="flex gap-2">
								<button
									onClick={handleFindPath}
									disabled={!pathFrom || !pathTo || pathFrom === pathTo}
									className="flex-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
								>
									Find Path
								</button>
								{(pathResult || pathSearched) && (
									<button
										onClick={handleClearPath}
										className="rounded border border-input px-2 py-1 text-xs hover:bg-accent"
									>
										Clear
									</button>
								)}
							</div>
							{pathFrom && pathTo && pathFrom === pathTo && (
								<p className="text-xs text-muted-foreground">Select two different concepts.</p>
							)}
							{pathSearched && !pathResult && (
								<p className="text-xs text-amber-500">No path found between these concepts.</p>
							)}
							{pathResult && (
								<div className="rounded bg-accent/50 p-2 text-xs">
									<div className="mb-1 font-medium">
										Path ({pathResult.nodeIds.length} nodes):
									</div>
									<div className="flex flex-wrap items-center gap-1">
										{pathResult.nodeIds.map((nid, i) => {
											const node = fullGraph.nodes.find((n) => n.id === nid);
											return (
												<span key={nid} className="flex items-center gap-1">
													{i > 0 && (
														<ArrowRight className="h-3 w-3 text-muted-foreground" />
													)}
													<button
														className="rounded bg-background px-1.5 py-0.5 hover:bg-primary/10"
														onClick={() => {
															setSelectedNodeId(nid);
															graphRef.current?.centerGraph([nid]);
														}}
													>
														{node?.label || nid}
													</button>
												</span>
											);
										})}
									</div>
								</div>
							)}
						</div>
					</div>
				</div>

				{/* Graph canvas */}
				<div className="relative flex-1">
					<GraphCanvas
						ref={graphRef}
						nodes={filteredGraph.nodes}
						edges={filteredGraph.edges}
						layoutType={layoutType}
						edgeArrowPosition="end"
						labelType="all"
						draggable
						selections={selections}
						onNodeClick={(node) => {
							setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
						}}
						onCanvasClick={() => setSelectedNodeId(null)}
					/>
				</div>

				{/* Right detail panel */}
				{selectedNodeDetail && (
					<div className="w-80 shrink-0 overflow-y-auto border-l border-border">
						<div className="flex items-center justify-between border-b border-border p-3">
							<div className="flex items-center gap-2">
								<span
									className="h-3 w-3 rounded-full"
									style={{ backgroundColor: selectedNodeDetail.node.fill || "#6b7280" }}
								/>
								<span className="text-xs font-medium uppercase text-muted-foreground">
									{selectedNodeDetail.node.data?.type}
								</span>
							</div>
							<button
								onClick={() => setSelectedNodeId(null)}
								className="text-muted-foreground hover:text-foreground"
							>
								<X className="h-4 w-4" />
							</button>
						</div>

						<div className="border-b border-border p-3">
							<h2 className="text-sm font-semibold">{selectedNodeDetail.node.label}</h2>
							{selectedNodeDetail.node.data?.description && (
								<p className="mt-1 text-xs text-muted-foreground">
									{selectedNodeDetail.node.data.description}
								</p>
							)}
							{selectedNodeDetail.node.data?.aliases && (
								<p className="mt-1 text-xs">
									<span className="text-muted-foreground">Aliases: </span>
									{selectedNodeDetail.node.data.aliases}
								</p>
							)}
						</div>

						<div className="p-3">
							<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
								Connections ({selectedNodeDetail.connections.length})
							</h3>
							{selectedNodeDetail.connections.length === 0 ? (
								<p className="text-xs text-muted-foreground">No connections (orphan node)</p>
							) : (
								<div className="space-y-1">
									{selectedNodeDetail.connections.map((conn) => (
										<button
											key={conn.edgeId}
											className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
											onClick={() => {
												setSelectedNodeId(conn.otherNodeId);
												graphRef.current?.centerGraph([conn.otherNodeId]);
											}}
										>
											<span className="mt-0.5 shrink-0 text-muted-foreground">
												{conn.direction === "outgoing" ? "→" : "←"}
											</span>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-1.5">
													<span
														className="h-2 w-2 shrink-0 rounded-full"
														style={{ backgroundColor: conn.otherNodeColor }}
													/>
													<span className="truncate font-medium">
														{conn.otherNodeLabel}
													</span>
												</div>
												<div className="mt-0.5 flex items-center gap-2 text-muted-foreground">
													<span
														className="inline-block h-1.5 w-3 rounded-sm"
														style={{
															backgroundColor:
																EDGE_COLORS[conn.relationship] || "#9ca3af",
														}}
													/>
													<span>{conn.relationship.replace(/_/g, " ")}</span>
													<span className="ml-auto">
														{(conn.confidence * 100).toFixed(0)}%
													</span>
												</div>
											</div>
										</button>
									))}
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
