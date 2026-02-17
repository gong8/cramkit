import type { FullGraphData, GraphStats, NodeDetailData } from "@/components/graph/constants.js";
import { buildGraphData, computeStats, findPath } from "@/components/graph/graph-utils.js";
import { fetchSession, fetchSessionGraph } from "@/lib/api.js";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { GraphCanvasRef, LayoutTypes } from "reagraph";

export function useGraphData(sessionId: string) {
	const graphRef = useRef<GraphCanvasRef>(null);

	// Data fetching
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
	const [pathResult, setPathResult] = useState<{
		nodeIds: string[];
		edgeIds: string[];
	} | null>(null);
	const [pathSearched, setPathSearched] = useState(false);
	const [highlightOrphans, setHighlightOrphans] = useState(false);

	// Full graph (unfiltered)
	const fullGraph = useMemo<FullGraphData | null>(
		() =>
			graph
				? buildGraphData(
						graph.concepts,
						graph.relationships,
						graph.resources,
						graph.chunkResourceMap,
					)
				: null,
		[graph],
	);

	// Stats
	const stats = useMemo<GraphStats | null>(
		() => (fullGraph ? computeStats(fullGraph.nodes, fullGraph.edges) : null),
		[fullGraph],
	);

	// Filtered graph
	const filteredGraph = useMemo(() => {
		if (!fullGraph) return null;

		const filteredNodeIds = new Set<string>();
		for (const node of fullGraph.nodes) {
			if (disabledNodeTypes.has(node.data?.type)) continue;
			if (node.data?.resourceId && disabledResourceIds.has(node.data.resourceId)) continue;
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
	const selectedNodeDetail = useMemo<NodeDetailData | null>(() => {
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

	const handleNodeClick = useCallback((nodeId: string) => {
		setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
	}, []);

	const handleCanvasClick = useCallback(() => {
		setSelectedNodeId(null);
	}, []);

	const navigateToNode = useCallback((nodeId: string) => {
		setSelectedNodeId(nodeId);
		graphRef.current?.centerGraph([nodeId]);
	}, []);

	return {
		graphRef,
		session,
		isLoading,
		error,
		fullGraph,
		filteredGraph,
		stats,
		selectedNodeId,
		selectedNodeDetail,
		searchQuery,
		setSearchQuery,
		searchOpen,
		setSearchOpen,
		searchResults,
		handleSearchSelect,
		selections,
		layoutType,
		setLayoutType,
		disabledNodeTypes,
		toggleNodeType,
		disabledRelTypes,
		toggleRelType,
		disabledResourceIds,
		toggleResource,
		toggleResourceType,
		confidenceThreshold,
		setConfidenceThreshold,
		highlightOrphans,
		setHighlightOrphans,
		conceptNodes,
		pathFrom,
		setPathFrom,
		pathTo,
		setPathTo,
		pathResult,
		setPathResult,
		pathSearched,
		setPathSearched,
		handleFindPath,
		handleClearPath,
		handleNodeClick,
		handleCanvasClick,
		navigateToNode,
	};
}
