import { fetchResourceContent, type Resource } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";

const TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-800",
	PAST_PAPER: "bg-amber-100 text-amber-800",
	PROBLEM_SHEET: "bg-purple-100 text-purple-800",
	SPECIFICATION: "bg-gray-100 text-gray-800",
	OTHER: "bg-gray-100 text-gray-800",
};

const TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Notes",
	PAST_PAPER: "Paper",
	PROBLEM_SHEET: "Sheet",
	SPECIFICATION: "Spec",
	OTHER: "Other",
};

function ResourceContent({ resourceId }: { resourceId: string }) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["resource-content", resourceId],
		queryFn: () => fetchResourceContent(resourceId),
		enabled: !!resourceId,
	});

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<p className="text-sm text-muted-foreground">Loading resource...</p>
			</div>
		);
	}

	if (error || !data) {
		return (
			<div className="flex h-full items-center justify-center">
				<p className="text-sm text-muted-foreground">
					{error ? "Failed to load resource" : "Resource not found"}
				</p>
			</div>
		);
	}

	return (
		<div className="prose prose-sm max-w-none p-4">
			<ReactMarkdown>{data.content}</ReactMarkdown>
		</div>
	);
}

interface FileViewerProps {
	resources: Resource[];
	selectedResourceId: string | null;
	onSelectResource: (resourceId: string | null) => void;
}

export function FileViewer({ resources, selectedResourceId, onSelectResource }: FileViewerProps) {
	const indexedResources = resources.filter((r) => r.isIndexed);

	if (selectedResourceId) {
		const resource = resources.find((r) => r.id === selectedResourceId);
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2">
					<button
						onClick={() => onSelectResource(null)}
						className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronLeft className="h-4 w-4" />
					</button>
					<span className="truncate text-sm font-medium">
						{resource?.label || resource?.name || "Resource"}
					</span>
				</div>
				<div className="flex-1 overflow-y-auto">
					<ResourceContent resourceId={selectedResourceId} />
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-border px-3 py-2">
				<h3 className="text-sm font-semibold">Resources</h3>
			</div>
			<div className="flex-1 overflow-y-auto">
				{indexedResources.length === 0 ? (
					<p className="p-3 text-sm text-muted-foreground">No resources ready to view.</p>
				) : (
					<div className="divide-y divide-border">
						{indexedResources.map((resource) => (
							<button
								key={resource.id}
								onClick={() => onSelectResource(resource.id)}
								className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent"
							>
								<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm">{resource.label || resource.name}</p>
									<p className="truncate text-xs text-muted-foreground">
										{resource.files.length} file{resource.files.length !== 1 ? "s" : ""}
									</p>
								</div>
								<span
									className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
										TYPE_COLORS[resource.type] || TYPE_COLORS.OTHER
									}`}
								>
									{TYPE_LABELS[resource.type] || resource.type}
								</span>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
