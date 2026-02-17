import type { Concept, GraphResource, Relationship } from "@/lib/api.js";
import type { GraphEdge, GraphNode } from "reagraph";
import {
	EDGE_COLORS,
	type FullGraphData,
	type GraphStats,
	NODE_COLORS,
	RESOURCE_TYPE_COLORS,
} from "./constants.js";

export function buildGraphData(
	concepts: Concept[],
	relationships: Relationship[],
	resources: GraphResource[],
): FullGraphData {
	const nodeMap = new Map<string, GraphNode>();
	const nodeTypeSet = new Set<string>();
	const relTypeSet = new Set<string>();

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
				fill:
					(resMeta && RESOURCE_TYPE_COLORS[resMeta.type]) || NODE_COLORS[r.sourceType] || "#6b7280",
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
				fill:
					(resMeta && RESOURCE_TYPE_COLORS[resMeta.type]) || NODE_COLORS[r.targetType] || "#6b7280",
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

export function computeStats(nodes: GraphNode[], edges: GraphEdge[]): GraphStats {
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

export function findPath(
	edges: GraphEdge[],
	fromId: string,
	toId: string,
): { nodeIds: string[]; edgeIds: string[] } | null {
	const adj = new Map<string, { nodeId: string; edgeId: string }[]>();
	for (const edge of edges) {
		if (!adj.has(edge.source)) adj.set(edge.source, []);
		if (!adj.has(edge.target)) adj.set(edge.target, []);
		adj.get(edge.source)?.push({ nodeId: edge.target, edgeId: edge.id });
		adj.get(edge.target)?.push({ nodeId: edge.source, edgeId: edge.id });
	}

	const visited = new Set<string>([fromId]);
	const queue: { nodeId: string; path: string[]; edgePath: string[] }[] = [
		{ nodeId: fromId, path: [fromId], edgePath: [] },
	];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
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
