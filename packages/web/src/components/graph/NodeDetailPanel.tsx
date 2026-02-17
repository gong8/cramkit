import { X } from "lucide-react";
import type { NodeDetailData } from "./constants.js";
import { EDGE_COLORS } from "./constants.js";

export function NodeDetailPanel({
	detail,
	onClose,
	onNavigateToNode,
}: {
	detail: NodeDetailData;
	onClose: () => void;
	onNavigateToNode: (nodeId: string) => void;
}) {
	return (
		<div className="w-80 shrink-0 overflow-y-auto border-l border-border">
			<div className="flex items-center justify-between border-b border-border p-3">
				<div className="flex items-center gap-2">
					<span
						className="h-3 w-3 rounded-full"
						style={{ backgroundColor: detail.node.fill || "#6b7280" }}
					/>
					<span className="text-xs font-medium uppercase text-muted-foreground">
						{detail.node.data?.type}
					</span>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="border-b border-border p-3">
				<h2 className="text-sm font-semibold">{detail.node.label}</h2>
				{detail.node.data?.description && (
					<p className="mt-1 text-xs text-muted-foreground">{detail.node.data.description}</p>
				)}
				{detail.node.data?.aliases && (
					<p className="mt-1 text-xs">
						<span className="text-muted-foreground">Aliases: </span>
						{detail.node.data.aliases}
					</p>
				)}
			</div>

			<div className="p-3">
				<h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
					Connections ({detail.connections.length})
				</h3>
				{detail.connections.length === 0 ? (
					<p className="text-xs text-muted-foreground">No connections (orphan node)</p>
				) : (
					<div className="space-y-1">
						{detail.connections.map((conn) => (
							<button
								type="button"
								key={conn.edgeId}
								className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
								onClick={() => onNavigateToNode(conn.otherNodeId)}
							>
								<span className="mt-0.5 shrink-0 text-muted-foreground">
									{conn.direction === "outgoing" ? "\u2192" : "\u2190"}
								</span>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span
											className="h-2 w-2 shrink-0 rounded-full"
											style={{ backgroundColor: conn.otherNodeColor }}
										/>
										<span className="truncate font-medium">{conn.otherNodeLabel}</span>
									</div>
									<div className="mt-0.5 flex items-center gap-2 text-muted-foreground">
										<span
											className="inline-block h-1.5 w-3 rounded-sm"
											style={{
												backgroundColor: EDGE_COLORS[conn.relationship] || "#9ca3af",
											}}
										/>
										<span>{conn.relationship.replace(/_/g, " ")}</span>
										<span className="ml-auto">{(conn.confidence * 100).toFixed(0)}%</span>
									</div>
								</div>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
