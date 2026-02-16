import { createResource, type Resource } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

const log = createLogger("web");

type ResourceType = "LECTURE_NOTES" | "PAST_PAPER" | "PROBLEM_SHEET" | "SPECIFICATION" | "OTHER";

const TYPE_OPTIONS: Array<{ value: ResourceType; label: string }> = [
	{ value: "LECTURE_NOTES", label: "Lecture Notes" },
	{ value: "PAST_PAPER", label: "Past Paper" },
	{ value: "PROBLEM_SHEET", label: "Problem Sheet" },
	{ value: "SPECIFICATION", label: "Specification" },
	{ value: "OTHER", label: "Other" },
];

interface ResourceUploadProps {
	sessionId: string;
	existingResources?: Resource[];
}

export function ResourceUpload({ sessionId, existingResources }: ResourceUploadProps) {
	const queryClient = useQueryClient();
	const [isDragging, setIsDragging] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [resourceType, setResourceType] = useState<ResourceType>("OTHER");
	const [resourceName, setResourceName] = useState("");
	const [secondaryFile, setSecondaryFile] = useState<File | null>(null);

	const needsSecondary = resourceType === "PAST_PAPER" || resourceType === "PROBLEM_SHEET";
	const secondaryLabel = resourceType === "PAST_PAPER" ? "Mark Scheme" : "Solutions";

	// Check if session already has lecture notes
	const existingLectureNotes = existingResources?.find((r) => r.type === "LECTURE_NOTES");
	const isAddingToExisting = resourceType === "LECTURE_NOTES" && !!existingLectureNotes;

	const handleFiles = useCallback(
		async (files: FileList) => {
			log.info(`handleFiles — ${files.length} file(s) selected, type=${resourceType}`);
			setUploading(true);
			try {
				const fileArray = Array.from(files);
				const name = resourceName || fileArray.map((f) => f.name.replace(/\.[^.]+$/, "")).join(", ");

				await createResource(sessionId, {
					name,
					type: resourceType,
					files: fileArray,
					markScheme: resourceType === "PAST_PAPER" ? secondaryFile ?? undefined : undefined,
					solutions: resourceType === "PROBLEM_SHEET" ? secondaryFile ?? undefined : undefined,
				});

				log.info("handleFiles — resource created");
				setResourceName("");
				setSecondaryFile(null);
				queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
			} catch (err) {
				log.error("handleFiles — upload error", err);
			} finally {
				setUploading(false);
			}
		},
		[sessionId, queryClient, resourceType, resourceName, secondaryFile],
	);

	return (
		<div className="mb-4 space-y-3">
			{/* Resource type selector */}
			<div className="flex flex-wrap gap-2">
				{TYPE_OPTIONS.map((opt) => (
					<button
						key={opt.value}
						type="button"
						onClick={() => {
							setResourceType(opt.value);
							setSecondaryFile(null);
						}}
						className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
							resourceType === opt.value
								? "bg-primary text-primary-foreground"
								: "bg-secondary text-secondary-foreground hover:opacity-80"
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>

			{/* Info about adding to existing lecture notes */}
			{isAddingToExisting && (
				<p className="text-xs text-muted-foreground">
					Files will be added to existing Lecture Notes resource.
				</p>
			)}

			{/* Resource name */}
			{!isAddingToExisting && (
				<input
					type="text"
					value={resourceName}
					onChange={(e) => setResourceName(e.target.value)}
					placeholder="Resource name (optional — defaults to filename)"
					className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
				/>
			)}

			{/* Secondary file for past paper / problem sheet */}
			{needsSecondary && (
				<div className="rounded-md border border-dashed border-border p-3">
					{secondaryFile ? (
						<div className="flex items-center justify-between text-sm">
							<span>{secondaryLabel}: {secondaryFile.name}</span>
							<button
								onClick={() => setSecondaryFile(null)}
								className="text-muted-foreground hover:text-destructive"
							>
								Remove
							</button>
						</div>
					) : (
						<label className="block cursor-pointer text-center text-sm text-muted-foreground">
							{`Attach ${secondaryLabel} (optional)`}
							<input
								type="file"
								className="hidden"
								onChange={(e) => {
									if (e.target.files?.[0]) setSecondaryFile(e.target.files[0]);
								}}
							/>
						</label>
					)}
				</div>
			)}

			{/* Main file dropzone */}
			<div
				onDragOver={(e) => {
					e.preventDefault();
					setIsDragging(true);
				}}
				onDragLeave={() => setIsDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setIsDragging(false);
					if (e.dataTransfer.files.length) {
						handleFiles(e.dataTransfer.files);
					}
				}}
				className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
					isDragging ? "border-primary bg-primary/5" : "border-border text-muted-foreground"
				}`}
			>
				{uploading ? (
					<p className="text-sm">Uploading...</p>
				) : (
					<>
						<p className="text-sm">
							{resourceType === "LECTURE_NOTES"
								? "Drag & drop lecture note files here, or"
								: "Drag & drop files here, or"}
						</p>
						<label className="mt-2 inline-block cursor-pointer rounded-md bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground hover:opacity-80">
							Browse
							<input
								type="file"
								multiple={resourceType === "LECTURE_NOTES"}
								className="hidden"
								onChange={(e) => {
									if (e.target.files?.length) handleFiles(e.target.files);
								}}
							/>
						</label>
					</>
				)}
			</div>
		</div>
	);
}
