import { X } from "lucide-react";
import { useMemo, useState } from "react";
import type { GraphNode } from "reagraph";

export function NodePicker({
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
				? nodes
						.filter((n) => (n.label ?? "").toLowerCase().includes(query.toLowerCase()))
						.slice(0, 8)
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
							type="button"
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
					type="button"
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
