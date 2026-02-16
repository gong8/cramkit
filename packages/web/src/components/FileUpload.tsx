import { uploadFile } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

const log = createLogger("web");

const FILE_TYPE_OPTIONS: Record<string, string> = {
	OTHER: "Other",
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	MARK_SCHEME: "Mark Scheme",
	PROBLEM_SHEET: "Problem Sheet",
	PROBLEM_SHEET_SOLUTIONS: "Solutions",
	SPECIFICATION: "Specification",
};

interface FileUploadProps {
	sessionId: string;
}

export function FileUpload({ sessionId }: FileUploadProps) {
	const queryClient = useQueryClient();
	const [isDragging, setIsDragging] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [fileType, setFileType] = useState("OTHER");

	const handleFiles = useCallback(
		async (files: FileList) => {
			log.info(`handleFiles — ${files.length} file(s) selected`);
			setUploading(true);
			try {
				for (const file of Array.from(files)) {
					log.info(`handleFiles — uploading "${file.name}"`);
					await uploadFile(sessionId, file, fileType);
					log.info(`handleFiles — completed "${file.name}"`);
				}
				log.info("handleFiles — all uploads done");
				queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
			} catch (err) {
				log.error("handleFiles — upload error", err);
			} finally {
				setUploading(false);
			}
		},
		[sessionId, queryClient, fileType],
	);

	return (
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
			className={`mb-4 rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
				isDragging ? "border-primary bg-primary/5" : "border-border text-muted-foreground"
			}`}
		>
			{uploading ? (
				<p className="text-sm">Uploading...</p>
			) : (
				<>
					<select
						value={fileType}
						onChange={(e) => setFileType(e.target.value)}
						className="mx-auto mb-3 block w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
					>
						{Object.entries(FILE_TYPE_OPTIONS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
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
	);
}
