import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
	mcp__cramkit__search_notes: (a) => `Searched notes for "${a.query ?? ""}"`,
	mcp__cramkit__get_resource_content: () => "Read resource content",
	mcp__cramkit__get_resource_info: () => "Read resource info",
	mcp__cramkit__get_resource_index: () => "Read resource index",
	mcp__cramkit__get_chunk: () => "Read content chunk",
	mcp__cramkit__list_concepts: () => "Listed concepts",
	mcp__cramkit__get_concept: () => "Read concept details",
	mcp__cramkit__get_related: () => "Found related items",
	mcp__cramkit__create_link: () => "Created knowledge link",
	mcp__cramkit__list_sessions: () => "Listed sessions",
	mcp__cramkit__get_session: () => "Read session details",
	mcp__cramkit__get_exam_scope: () => "Read exam scope",
	mcp__cramkit__list_past_papers: () => "Listed past papers",
	mcp__cramkit__list_problem_sheets: () => "Listed problem sheets",
	mcp__cramkit__get_past_paper: () => "Read past paper",
	Read: (a) => {
		const path = typeof a.file_path === "string" ? a.file_path : "";
		const name = path.split("/").pop() || path;
		return name ? `Read file: ${name}` : "Read file";
	},
	mcp__images__view_image: (a) => {
		const path = typeof a.file_path === "string" ? a.file_path : "";
		const name = path.split("/").pop() || "image";
		return `Viewing ${name}`;
	},
};

export function getToolLabel(toolName: string, args: Record<string, unknown>): string {
	const fn = TOOL_LABELS[toolName];
	if (fn) return fn(args);
	const short = toolName.replace(/^mcp__cramkit__/, "");
	return short.replace(/_/g, " ");
}

export function ToolCallDisplay(props: ToolCallMessagePartProps) {
	const { toolName, args, result, isError } = props;
	const [expanded, setExpanded] = useState(false);
	const hasResult = result !== undefined;
	const label = getToolLabel(toolName, args);

	return (
		<div className="my-1.5 rounded-lg border border-border bg-background text-sm">
			<button
				type="button"
				onClick={() => hasResult && setExpanded(!expanded)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors rounded-lg"
				disabled={!hasResult}
			>
				{isError ? (
					<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
				) : hasResult ? (
					<Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
				) : (
					<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
				)}
				<span
					className={`flex-1 truncate ${isError ? "text-destructive" : "text-muted-foreground"}`}
				>
					{hasResult ? label : `${label}...`}
				</span>
				{hasResult &&
					(expanded ? (
						<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					))}
			</button>
			{expanded && hasResult && (
				<div className="border-t border-border px-3 py-2">
					<pre className="max-h-48 overflow-auto text-xs text-muted-foreground whitespace-pre-wrap break-all">
						{typeof result === "string" ? result : JSON.stringify(result, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
