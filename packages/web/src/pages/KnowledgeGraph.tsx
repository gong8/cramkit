import { GraphHeader } from "@/components/graph/GraphHeader.js";
import { GraphSidebar } from "@/components/graph/GraphSidebar.js";
import { NodeDetailPanel } from "@/components/graph/NodeDetailPanel.js";
import { GRAPH_THEME } from "@/components/graph/constants.js";
import { useGraphData } from "@/hooks/useGraphData.js";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { GraphCanvas } from "reagraph";

export function KnowledgeGraph() {
	const { id } = useParams<{ id: string }>();
	const sessionId = id as string;
	const g = useGraphData(sessionId);

	if (g.isLoading) {
		return (
			<div className="flex h-screen items-center justify-center text-muted-foreground">
				Loading graph...
			</div>
		);
	}
	if (g.error) {
		return (
			<div className="flex h-screen items-center justify-center text-destructive">
				Failed to load graph data.
			</div>
		);
	}
	if (!g.filteredGraph || !g.fullGraph || g.fullGraph.nodes.length === 0) {
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
					<h1 className="text-sm font-semibold">
						{g.session?.name ?? "Session"} — Knowledge Graph
					</h1>
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
			<GraphHeader
				sessionId={sessionId}
				sessionName={g.session?.name ?? "Session"}
				filteredNodeCount={g.filteredGraph.nodes.length}
				totalNodeCount={g.fullGraph.nodes.length}
				filteredEdgeCount={g.filteredGraph.edges.length}
				totalEdgeCount={g.fullGraph.edges.length}
				searchQuery={g.searchQuery}
				setSearchQuery={g.setSearchQuery}
				searchOpen={g.searchOpen}
				setSearchOpen={g.setSearchOpen}
				searchResults={g.searchResults}
				onSearchSelect={g.handleSearchSelect}
				layoutType={g.layoutType}
				setLayoutType={g.setLayoutType}
			/>

			<div className="flex flex-1 overflow-hidden">
				<GraphSidebar
					fullGraph={g.fullGraph}
					stats={g.stats}
					disabledNodeTypes={g.disabledNodeTypes}
					toggleNodeType={g.toggleNodeType}
					disabledRelTypes={g.disabledRelTypes}
					toggleRelType={g.toggleRelType}
					disabledResourceIds={g.disabledResourceIds}
					toggleResource={g.toggleResource}
					toggleResourceType={g.toggleResourceType}
					confidenceThreshold={g.confidenceThreshold}
					setConfidenceThreshold={g.setConfidenceThreshold}
					highlightOrphans={g.highlightOrphans}
					setHighlightOrphans={g.setHighlightOrphans}
					conceptNodes={g.conceptNodes}
					pathFrom={g.pathFrom}
					setPathFrom={g.setPathFrom}
					pathTo={g.pathTo}
					setPathTo={g.setPathTo}
					pathResult={g.pathResult}
					setPathResult={g.setPathResult}
					pathSearched={g.pathSearched}
					setPathSearched={g.setPathSearched}
					onFindPath={g.handleFindPath}
					onClearPath={g.handleClearPath}
					onNavigateToNode={g.navigateToNode}
				/>

				<div className="relative flex-1">
					<GraphCanvas
						ref={g.graphRef}
						nodes={g.filteredGraph.nodes}
						edges={g.filteredGraph.edges}
						layoutType={g.layoutType}
						edgeArrowPosition="end"
						labelType="all"
						draggable
						theme={GRAPH_THEME}
						selections={g.selections}
						onNodeClick={(node) => g.handleNodeClick(node.id)}
						onCanvasClick={g.handleCanvasClick}
					/>
				</div>

				{g.selectedNodeDetail && (
					<NodeDetailPanel
						detail={g.selectedNodeDetail}
						onClose={g.handleCanvasClick}
						onNavigateToNode={g.navigateToNode}
					/>
				)}
			</div>
		</div>
	);
}
