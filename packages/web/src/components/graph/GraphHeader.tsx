import { ArrowLeft, Search, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { GraphNode, LayoutTypes } from "reagraph";
import { LAYOUT_OPTIONS } from "./constants.js";

export function GraphHeader({
	sessionId,
	sessionName,
	filteredNodeCount,
	totalNodeCount,
	filteredEdgeCount,
	totalEdgeCount,
	searchQuery,
	setSearchQuery,
	searchOpen,
	setSearchOpen,
	searchResults,
	onSearchSelect,
	layoutType,
	setLayoutType,
}: {
	sessionId: string;
	sessionName: string;
	filteredNodeCount: number;
	totalNodeCount: number;
	filteredEdgeCount: number;
	totalEdgeCount: number;
	searchQuery: string;
	setSearchQuery: (q: string) => void;
	searchOpen: boolean;
	setSearchOpen: (open: boolean) => void;
	searchResults: GraphNode[];
	onSearchSelect: (nodeId: string) => void;
	layoutType: LayoutTypes;
	setLayoutType: (layout: LayoutTypes) => void;
}) {
	return (
		<div className="flex items-center gap-3 border-b border-border px-4 py-2">
			<Link
				to={`/session/${sessionId}`}
				className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeft className="h-4 w-4" />
				Back
			</Link>
			<div className="h-4 w-px bg-border" />
			<h1 className="shrink-0 text-sm font-semibold">{sessionName} — Knowledge Graph</h1>
			<span className="shrink-0 text-xs text-muted-foreground">
				{filteredNodeCount}/{totalNodeCount} nodes, {filteredEdgeCount}/{totalEdgeCount} edges
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
							type="button"
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
								type="button"
								key={n.id}
								className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
								onMouseDown={(e) => {
									e.preventDefault();
									onSearchSelect(n.id);
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
	);
}
