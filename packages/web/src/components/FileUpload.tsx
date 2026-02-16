import { linkFile, uploadFile } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

const log = createLogger("web");

type UploadCategory = "PAST_PAPER" | "PROBLEM_SHEET" | "LECTURE_NOTES" | "SPECIFICATION" | "OTHER";

const CATEGORY_OPTIONS: Array<{ value: UploadCategory; label: string }> = [
	{ value: "LECTURE_NOTES", label: "Lecture Notes" },
	{ value: "PAST_PAPER", label: "Past Paper" },
	{ value: "PROBLEM_SHEET", label: "Problem Sheet" },
	{ value: "SPECIFICATION", label: "Specification" },
	{ value: "OTHER", label: "Other" },
];

interface FileUploadProps {
	sessionId: string;
}

export function FileUpload({ sessionId }: FileUploadProps) {
	const queryClient = useQueryClient();
	const [isDragging, setIsDragging] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [category, setCategory] = useState<UploadCategory>("OTHER");
	const [combinedIncluded, setCombinedIncluded] = useState(false);
	const [secondaryFile, setSecondaryFile] = useState<File | null>(null);

	const needsSecondary = category === "PAST_PAPER" || category === "PROBLEM_SHEET";
	const combinedLabel = category === "PAST_PAPER" ? "Mark scheme included" : "Solutions included";
	const secondaryLabel = category === "PAST_PAPER" ? "Mark Scheme" : "Solutions";
	const combinedType = category === "PAST_PAPER" ? "PAST_PAPER_WITH_MARK_SCHEME" : "PROBLEM_SHEET_WITH_SOLUTIONS";

	const handleFiles = useCallback(
		async (files: FileList) => {
			log.info(`handleFiles — ${files.length} file(s) selected`);
			setUploading(true);
			try {
				for (const file of Array.from(files)) {
					// Determine the file type
					const fileType = needsSecondary && combinedIncluded ? combinedType : category;

					log.info(`handleFiles — uploading "${file.name}" as ${fileType}`);
					const uploaded = await uploadFile(sessionId, file, fileType);
					log.info(`handleFiles — completed "${file.name}"`);

					// Upload and link secondary file if provided
					if (needsSecondary && !combinedIncluded && secondaryFile) {
						const secondaryType = category === "PAST_PAPER" ? "MARK_SCHEME" : "PROBLEM_SHEET_SOLUTIONS";
						const relationship = category === "PAST_PAPER" ? "mark_scheme_of" : "solutions_of";

						log.info(`handleFiles — uploading secondary "${secondaryFile.name}"`);
						const secondaryUploaded = await uploadFile(sessionId, secondaryFile, secondaryType);
						log.info(`handleFiles — linking ${uploaded.id} -> ${secondaryUploaded.id}`);
						await linkFile(uploaded.id, secondaryUploaded.id, relationship);
						setSecondaryFile(null);
					}
				}
				log.info("handleFiles — all uploads done");
				queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
			} catch (err) {
				log.error("handleFiles — upload error", err);
			} finally {
				setUploading(false);
			}
		},
		[sessionId, queryClient, category, combinedIncluded, secondaryFile, needsSecondary, combinedType],
	);

	return (
		<div className="mb-4 space-y-3">
			{/* Category selector */}
			<div className="flex flex-wrap gap-2">
				{CATEGORY_OPTIONS.map((opt) => (
					<button
						key={opt.value}
						type="button"
						onClick={() => {
							setCategory(opt.value);
							setCombinedIncluded(false);
							setSecondaryFile(null);
						}}
						className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
							category === opt.value
								? "bg-primary text-primary-foreground"
								: "bg-secondary text-secondary-foreground hover:opacity-80"
						}`}
					>
						{opt.label}
					</button>
				))}
			</div>

			{/* Combined checkbox for past paper / problem sheet */}
			{needsSecondary && (
				<div className="space-y-2">
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={combinedIncluded}
							onChange={(e) => {
								setCombinedIncluded(e.target.checked);
								if (e.target.checked) setSecondaryFile(null);
							}}
							className="rounded border-input"
						/>
						{combinedLabel}
					</label>

					{/* Secondary file dropzone */}
					{!combinedIncluded && (
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
						<p className="text-sm">Drag & drop files here, or</p>
						<label className="mt-2 inline-block cursor-pointer rounded-md bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground hover:opacity-80">
							Browse
							<input
								type="file"
								multiple
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
