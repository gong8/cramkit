import { uploadFile } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

interface FileUploadProps {
	sessionId: string;
}

export function FileUpload({ sessionId }: FileUploadProps) {
	const queryClient = useQueryClient();
	const [isDragging, setIsDragging] = useState(false);
	const [uploading, setUploading] = useState(false);

	const handleFiles = useCallback(
		async (files: FileList) => {
			setUploading(true);
			try {
				for (const file of Array.from(files)) {
					await uploadFile(sessionId, file, "OTHER");
				}
				queryClient.invalidateQueries({ queryKey: ["session-files", sessionId] });
			} finally {
				setUploading(false);
			}
		},
		[sessionId, queryClient],
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
