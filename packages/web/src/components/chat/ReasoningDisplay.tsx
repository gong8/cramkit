import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

export function ReasoningDisplay({ text }: { type: "reasoning"; text: string; status?: unknown }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="my-1.5 rounded-lg border border-border bg-amber-50/50 dark:bg-amber-950/20 text-sm">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors rounded-lg"
			>
				<span className="text-amber-600 dark:text-amber-400 text-xs font-medium">Thinking</span>
				<span className="flex-1" />
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				)}
			</button>
			{expanded && (
				<div className="border-t border-border px-3 py-2">
					<pre className="max-h-64 overflow-auto text-xs text-muted-foreground whitespace-pre-wrap">
						{text}
					</pre>
				</div>
			)}
		</div>
	);
}
