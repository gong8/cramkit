import { createResource, type Resource } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

const log = createLogger("web");

type ResourceType = "LECTURE_NOTES" | "PAST_PAPER" | "PROBLEM_SHEET" | "SPECIFICATION" | "OTHER";

const TYPE_OPTIONS: Array<{ value: ResourceType; label: string; description: string }> = [
	{ value: "LECTURE_NOTES", label: "Lecture Notes", description: "One or more lecture PDFs" },
	{ value: "PAST_PAPER", label: "Past Paper", description: "A single exam paper PDF" },
	{ value: "PROBLEM_SHEET", label: "Problem Sheet", description: "A single problem sheet PDF" },
	{ value: "SPECIFICATION", label: "Specification", description: "Module or exam specification" },
	{ value: "OTHER", label: "Other", description: "Any other resource" },
];

interface ResourceUploadProps {
	sessionId: string;
	existingResources?: Resource[];
}

export function ResourceUpload({ sessionId, existingResources }: ResourceUploadProps) {
	const queryClient = useQueryClient();
	const [isOpen, setIsOpen] = useState(false);
	const [step, setStep] = useState<"type" | "details">("type");
	const [resourceType, setResourceType] = useState<ResourceType | null>(null);
	const [resourceName, setResourceName] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const [hasMarkScheme, setHasMarkScheme] = useState(false);
	const [hasSolutions, setHasSolutions] = useState(false);
	const [splitMode, setSplitMode] = useState<"auto" | "split" | "single">("auto");
	const [markSchemeFile, setMarkSchemeFile] = useState<File | null>(null);
	const [solutionsFile, setSolutionsFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const secondaryFileInputRef = useRef<HTMLInputElement>(null);

	const existingLectureNotes = existingResources?.find((r) => r.type === "LECTURE_NOTES");
	const isAddingToExisting = resourceType === "LECTURE_NOTES" && !!existingLectureNotes;

	const allowMultipleFiles = resourceType === "LECTURE_NOTES";

	const reset = useCallback(() => {
		setStep("type");
		setResourceType(null);
		setResourceName("");
		setFiles([]);
		setHasMarkScheme(false);
		setHasSolutions(false);
		setMarkSchemeFile(null);
		setSolutionsFile(null);
		setSplitMode("auto");
	}, []);

	const handleOpen = () => {
		reset();
		setIsOpen(true);
	};

	const handleClose = () => {
		if (!uploading) {
			setIsOpen(false);
			reset();
		}
	};

	const handleTypeSelect = (type: ResourceType) => {
		setResourceType(type);
		setStep("details");
	};

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files) {
			const newFiles = Array.from(e.target.files);
			if (allowMultipleFiles) {
				setFiles((prev) => [...prev, ...newFiles]);
			} else {
				setFiles(newFiles.slice(0, 1));
			}
		}
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	const removeFile = (index: number) => {
		setFiles((prev) => prev.filter((_, i) => i !== index));
	};

	const handleSubmit = useCallback(async () => {
		if (!resourceType || files.length === 0) return;
		setUploading(true);
		try {
			const name = resourceName || files.map((f) => f.name.replace(/\.[^.]+$/, "")).join(", ");

			let label: string | undefined;
			if (resourceType === "PAST_PAPER" && hasMarkScheme) {
				label = "includes_mark_scheme";
			} else if (resourceType === "PROBLEM_SHEET" && hasSolutions) {
				label = "includes_solutions";
			}

			await createResource(sessionId, {
				name,
				type: resourceType,
				label,
				splitMode: splitMode !== "auto" ? splitMode : undefined,
				files,
				markScheme: markSchemeFile ?? undefined,
				solutions: solutionsFile ?? undefined,
			});

			log.info("ResourceUpload — resource created");
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
			setIsOpen(false);
			reset();
		} catch (err) {
			log.error("ResourceUpload — upload error", err);
		} finally {
			setUploading(false);
		}
	}, [resourceType, files, resourceName, hasMarkScheme, hasSolutions, markSchemeFile, solutionsFile, splitMode, sessionId, queryClient, reset]);

	return (
		<>
			<button
				onClick={handleOpen}
				className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
			>
				<Plus className="h-4 w-4" />
				Add Resource
			</button>

			{isOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
					<div
						className="relative w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg"
						onClick={(e) => e.stopPropagation()}
					>
						<button
							onClick={handleClose}
							className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:text-foreground"
						>
							<X className="h-4 w-4" />
						</button>

						{/* Step 1: Pick resource type */}
						{step === "type" && (
							<>
								<h2 className="mb-4 text-lg font-semibold">What are you uploading?</h2>
								<div className="space-y-2">
									{TYPE_OPTIONS.map((opt) => {
										const isExisting = opt.value === "LECTURE_NOTES" && !!existingLectureNotes;
										return (
											<button
												key={opt.value}
												onClick={() => handleTypeSelect(opt.value)}
												className="flex w-full items-center justify-between rounded-md border border-border px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5"
											>
												<div>
													<div className="text-sm font-medium">{opt.label}</div>
													<div className="text-xs text-muted-foreground">
														{isExisting ? "Add more files to existing lecture notes" : opt.description}
													</div>
												</div>
											</button>
										);
									})}
								</div>
							</>
						)}

						{/* Step 2: Upload details */}
						{step === "details" && resourceType && (
							<>
								<h2 className="mb-4 text-lg font-semibold">
									{isAddingToExisting
										? "Add to Lecture Notes"
										: `New ${TYPE_OPTIONS.find((o) => o.value === resourceType)?.label}`}
								</h2>

								<div className="space-y-4">
									{/* Resource name */}
									{!isAddingToExisting && (
										<div>
											<label className="mb-1 block text-sm font-medium">
												Name <span className="font-normal text-muted-foreground">(optional)</span>
											</label>
											<input
												type="text"
												value={resourceName}
												onChange={(e) => setResourceName(e.target.value)}
												placeholder="Defaults to filename"
												className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
											/>
										</div>
									)}

									{/* Tickbox: includes mark scheme */}
									{resourceType === "PAST_PAPER" && (
										<label className="flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												checked={hasMarkScheme}
												onChange={(e) => setHasMarkScheme(e.target.checked)}
												className="h-4 w-4 rounded border-input"
											/>
											PDF includes mark scheme
										</label>
									)}

									{/* Tickbox: includes solutions */}
									{resourceType === "PROBLEM_SHEET" && (
										<label className="flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												checked={hasSolutions}
												onChange={(e) => setHasSolutions(e.target.checked)}
												className="h-4 w-4 rounded border-input"
											/>
											PDF includes solutions
										</label>
									)}

									{/* Split mode tickbox — only for lecture notes */}
									{resourceType === "LECTURE_NOTES" && (
										<label className="flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												checked={splitMode === "split"}
												onChange={(e) => setSplitMode(e.target.checked ? "split" : "auto")}
												className="h-4 w-4 rounded border-input"
											/>
											Split into chunks for indexing
										</label>
									)}

									{/* File upload */}
									<div>
										<label className="mb-1 block text-sm font-medium">
											{allowMultipleFiles ? "Files" : "File"}
										</label>

										{files.length > 0 && (
											<div className="mb-2 space-y-1">
												{files.map((file, i) => (
													<div
														key={`${file.name}-${i}`}
														className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm"
													>
														<span className="truncate">{file.name}</span>
														<button
															onClick={() => removeFile(i)}
															className="ml-2 text-muted-foreground hover:text-destructive"
														>
															<X className="h-3.5 w-3.5" />
														</button>
													</div>
												))}
											</div>
										)}

										{(allowMultipleFiles || files.length === 0) && (
											<button
												onClick={() => fileInputRef.current?.click()}
												className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
											>
												<Upload className="h-4 w-4" />
												{files.length > 0 ? "Add more files" : "Choose file"}
											</button>
										)}

										<input
											ref={fileInputRef}
											type="file"
											accept=".pdf"
											multiple={allowMultipleFiles}
											onChange={handleFileChange}
											className="hidden"
										/>
									</div>

									{/* Separate mark scheme file upload */}
									{resourceType === "PAST_PAPER" && !hasMarkScheme && (
										<div>
											<label className="mb-1 block text-sm font-medium">
												Mark Scheme <span className="font-normal text-muted-foreground">(optional)</span>
											</label>
											{markSchemeFile ? (
												<div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
													<span className="truncate">{markSchemeFile.name}</span>
													<button
														onClick={() => setMarkSchemeFile(null)}
														className="ml-2 text-muted-foreground hover:text-destructive"
													>
														<X className="h-3.5 w-3.5" />
													</button>
												</div>
											) : (
												<button
													onClick={() => secondaryFileInputRef.current?.click()}
													className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
												>
													<Upload className="h-4 w-4" />
													Choose mark scheme PDF
												</button>
											)}
											<input
												ref={secondaryFileInputRef}
												type="file"
												accept=".pdf"
												onChange={(e) => {
													if (e.target.files?.[0]) setMarkSchemeFile(e.target.files[0]);
													if (secondaryFileInputRef.current) secondaryFileInputRef.current.value = "";
												}}
												className="hidden"
											/>
										</div>
									)}

									{/* Separate solutions file upload */}
									{resourceType === "PROBLEM_SHEET" && !hasSolutions && (
										<div>
											<label className="mb-1 block text-sm font-medium">
												Solutions <span className="font-normal text-muted-foreground">(optional)</span>
											</label>
											{solutionsFile ? (
												<div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
													<span className="truncate">{solutionsFile.name}</span>
													<button
														onClick={() => setSolutionsFile(null)}
														className="ml-2 text-muted-foreground hover:text-destructive"
													>
														<X className="h-3.5 w-3.5" />
													</button>
												</div>
											) : (
												<button
													onClick={() => secondaryFileInputRef.current?.click()}
													className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
												>
													<Upload className="h-4 w-4" />
													Choose solutions PDF
												</button>
											)}
											<input
												ref={secondaryFileInputRef}
												type="file"
												accept=".pdf"
												onChange={(e) => {
													if (e.target.files?.[0]) setSolutionsFile(e.target.files[0]);
													if (secondaryFileInputRef.current) secondaryFileInputRef.current.value = "";
												}}
												className="hidden"
											/>
										</div>
									)}

									{/* Actions */}
									<div className="flex items-center justify-between pt-2">
										<button
											onClick={() => {
												setStep("type");
												setFiles([]);
											}}
											className="text-sm text-muted-foreground hover:text-foreground"
										>
											Back
										</button>
										<button
											onClick={handleSubmit}
											disabled={files.length === 0 || uploading}
											className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
										>
											{uploading ? "Uploading..." : "Upload"}
										</button>
									</div>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</>
	);
}
