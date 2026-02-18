import { ResourceList } from "@/components/ResourceList";
import { ResourceUpload } from "@/components/ResourceUpload";
import type { BatchResource, Resource } from "@/lib/api";
import { Plus } from "lucide-react";

interface MaterialsTabProps {
	resources: Resource[];
	sessionId: string;
	batchResources: BatchResource[] | null;
}

export function MaterialsTab({ resources, sessionId, batchResources }: MaterialsTabProps) {
	return (
		<div className="space-y-4">
			<ResourceUpload sessionId={sessionId} existingResources={resources} />

			{resources.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
					<div className="mb-3 rounded-full bg-muted p-3">
						<Plus className="h-5 w-5 text-muted-foreground" />
					</div>
					<p className="text-sm font-medium text-foreground">No resources yet</p>
					<p className="mt-1 text-sm text-muted-foreground">Upload PDFs to get started</p>
				</div>
			) : (
				<ResourceList resources={resources} sessionId={sessionId} batchResources={batchResources} />
			)}
		</div>
	);
}
