import type { GraphResource } from "@/lib/api.js";
import { ArrowRight } from "lucide-react";
import type { GraphNode } from "reagraph";
import { NodePicker } from "./NodePicker.js";
import type { FullGraphData, GraphStats } from "./constants.js";
import {
	EDGE_COLORS,
	NODE_COLORS,
	RESOURCE_TYPE_COLORS,
	RESOURCE_TYPE_LABELS,
} from "./constants.js";

export function GraphSidebar({
	fullGraph,
	stats,
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
	onFindPath,
	onClearPath,
	onNavigateToNode,
}: {
	fullGraph: FullGraphData;
	stats: GraphStats | null;
	disabledNodeTypes: Set<string>;
	toggleNodeType: (type: string) => void;
	disabledRelTypes: Set<string>;
	toggleRelType: (type: string) => void;
	disabledResourceIds: Set<string>;
	toggleResource: (id: string) => void;
	toggleResourceType: (type: string) => void;
	confidenceThreshold: number;
	setConfidenceThreshold: (val: number) => void;
	highlightOrphans: boolean;
	setHighlightOrphans: (val: boolean) => void;
	conceptNodes: GraphNode[];
	pathFrom: string | null;
	setPathFrom: (id: string | null) => void;
	pathTo: string | null;
	setPathTo: (id: string | null) => void;
	pathResult: { nodeIds: string[]; edgeIds: string[] } | null;
	setPathResult: (val: { nodeIds: string[]; edgeIds: string[] } | null) => void;
	pathSearched: boolean;
	setPathSearched: (val: boolean) => void;
	onFindPath: () => void;
	onClearPath: () => void;
	onNavigateToNode: (nodeId: string) => void;
}) {
	return (
		<div className="w-64 shrink-0 overflow-y-auto border-r border-border">
			<NodeTypeFilter
				nodeTypes={fullGraph.nodeTypes}
				disabledNodeTypes={disabledNodeTypes}
				toggleNodeType={toggleNodeType}
				stats={stats}
			/>

			{fullGraph.resourcesByType.size > 0 && (
				<ResourceFilter
					resourcesByType={fullGraph.resourcesByType}
					disabledResourceIds={disabledResourceIds}
					toggleResource={toggleResource}
					toggleResourceType={toggleResourceType}
				/>
			)}

			<RelationshipFilter
				relTypes={fullGraph.relTypes}
				disabledRelTypes={disabledRelTypes}
				toggleRelType={toggleRelType}
				stats={stats}
			/>

			<ConfidenceSlider value={confidenceThreshold} onChange={setConfidenceThreshold} />

			<StatsPanel
				stats={stats}
				highlightOrphans={highlightOrphans}
				setHighlightOrphans={setHighlightOrphans}
			/>

			<PathfindingPanel
				conceptNodes={conceptNodes}
				fullGraphNodes={fullGraph.nodes}
				pathFrom={pathFrom}
				setPathFrom={setPathFrom}
				pathTo={pathTo}
				setPathTo={setPathTo}
				pathResult={pathResult}
				setPathResult={setPathResult}
				pathSearched={pathSearched}
				setPathSearched={setPathSearched}
				onFindPath={onFindPath}
				onClearPath={onClearPath}
				onNavigateToNode={onNavigateToNode}
			/>
		</div>
	);
}

function NodeTypeFilter({
	nodeTypes,
	disabledNodeTypes,
	toggleNodeType,
	stats,
}: {
	nodeTypes: string[];
	disabledNodeTypes: Set<string>;
	toggleNodeType: (type: string) => void;
	stats: GraphStats | null;
}) {
	return (
		<div className="border-b border-border p-3">
			<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Node Types</h3>
			<div className="space-y-1">
				{nodeTypes.map((type) => (
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
						<span className="ml-auto text-muted-foreground">{stats?.nodesByType[type] || 0}</span>
					</label>
				))}
			</div>
		</div>
	);
}

function ResourceFilter({
	resourcesByType,
	disabledResourceIds,
	toggleResource,
	toggleResourceType,
}: {
	resourcesByType: Map<string, GraphResource[]>;
	disabledResourceIds: Set<string>;
	toggleResource: (id: string) => void;
	toggleResourceType: (type: string) => void;
}) {
	return (
		<div className="border-b border-border p-3">
			<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Resources</h3>
			<div className="space-y-2">
				{Array.from(resourcesByType.entries()).map(([resType, typeResources]) => {
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
										backgroundColor: RESOURCE_TYPE_COLORS[resType] || "#6b7280",
									}}
								/>
								<span>{RESOURCE_TYPE_LABELS[resType] || resType}</span>
								<span className="ml-auto text-muted-foreground">{typeResources.length}</span>
							</label>
							<div className="ml-5 mt-1 space-y-0.5">
								{typeResources.map((r) => (
									<label key={r.id} className="flex cursor-pointer items-center gap-2 text-xs">
										<input
											type="checkbox"
											checked={!disabledResourceIds.has(r.id)}
											onChange={() => toggleResource(r.id)}
											className="rounded"
										/>
										<span className="truncate text-muted-foreground">{r.label || r.name}</span>
									</label>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function RelationshipFilter({
	relTypes,
	disabledRelTypes,
	toggleRelType,
	stats,
}: {
	relTypes: string[];
	disabledRelTypes: Set<string>;
	toggleRelType: (type: string) => void;
	stats: GraphStats | null;
}) {
	return (
		<div className="border-b border-border p-3">
			<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Relationships</h3>
			<div className="space-y-1">
				{relTypes.map((type) => (
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
						<span className="ml-auto text-muted-foreground">{stats?.edgesByType[type] || 0}</span>
					</label>
				))}
			</div>
		</div>
	);
}

function ConfidenceSlider({
	value,
	onChange,
}: {
	value: number;
	onChange: (val: number) => void;
}) {
	return (
		<div className="border-b border-border p-3">
			<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
				Min Confidence: {value.toFixed(2)}
			</h3>
			<input
				type="range"
				min={0}
				max={1}
				step={0.05}
				value={value}
				onChange={(e) => onChange(Number.parseFloat(e.target.value))}
				className="w-full accent-primary"
			/>
			<div className="mt-1 flex justify-between text-xs text-muted-foreground">
				<span>0</span>
				<span>1</span>
			</div>
		</div>
	);
}

function StatsPanel({
	stats,
	highlightOrphans,
	setHighlightOrphans,
}: {
	stats: GraphStats | null;
	highlightOrphans: boolean;
	setHighlightOrphans: (val: boolean) => void;
}) {
	return (
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
						<span className={`font-medium ${stats.orphanIds.length > 0 ? "text-amber-500" : ""}`}>
							{stats.orphanIds.length}
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

function PathfindingPanel({
	conceptNodes,
	fullGraphNodes,
	pathFrom,
	setPathFrom,
	pathTo,
	setPathTo,
	pathResult,
	setPathResult,
	pathSearched,
	setPathSearched,
	onFindPath,
	onClearPath,
	onNavigateToNode,
}: {
	conceptNodes: GraphNode[];
	fullGraphNodes: GraphNode[];
	pathFrom: string | null;
	setPathFrom: (id: string | null) => void;
	pathTo: string | null;
	setPathTo: (id: string | null) => void;
	pathResult: { nodeIds: string[]; edgeIds: string[] } | null;
	setPathResult: (val: { nodeIds: string[]; edgeIds: string[] } | null) => void;
	pathSearched: boolean;
	setPathSearched: (val: boolean) => void;
	onFindPath: () => void;
	onClearPath: () => void;
	onNavigateToNode: (nodeId: string) => void;
}) {
	return (
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
						type="button"
						onClick={onFindPath}
						disabled={!pathFrom || !pathTo || pathFrom === pathTo}
						className="flex-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
					>
						Find Path
					</button>
					{(pathResult || pathSearched) && (
						<button
							type="button"
							onClick={onClearPath}
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
						<div className="mb-1 font-medium">Path ({pathResult.nodeIds.length} nodes):</div>
						<div className="flex flex-wrap items-center gap-1">
							{pathResult.nodeIds.map((nid, i) => {
								const node = fullGraphNodes.find((n) => n.id === nid);
								return (
									<span key={nid} className="flex items-center gap-1">
										{i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
										<button
											type="button"
											className="rounded bg-background px-1.5 py-0.5 hover:bg-primary/10"
											onClick={() => onNavigateToNode(nid)}
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
	);
}
