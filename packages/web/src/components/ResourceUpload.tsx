import { type Resource, createResource } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Upload } from "lucide-react";
import { useCallback, useReducer, useRef, useState } from "react";
import {
	FileChip,
	Modal,
	type ResourceType,
	SecondaryFilePicker,
	TYPE_LABELS,
} from "./resource-utils.js";

const log = createLogger("web");

const TYPE_OPTIONS: Array<{ value: ResourceType; label: string; description: string }> = [
	{ value: "LECTURE_NOTES", label: "Lecture Notes", description: "One or more lecture PDFs" },
	{ value: "PAST_PAPER", label: "Past Paper", description: "A single exam paper PDF" },
	{ value: "PROBLEM_SHEET", label: "Problem Sheet", description: "A single problem sheet PDF" },
	{ value: "SPECIFICATION", label: "Specification", description: "Module or exam specification" },
	{ value: "OTHER", label: "Other", description: "Any other resource" },
];

interface FormState {
	step: "type" | "details";
	resourceType: ResourceType | null;
	resourceName: string;
	files: File[];
	hasMarkScheme: boolean;
	hasSolutions: boolean;
	splitMode: "auto" | "split" | "single";
	markSchemeFile: File | null;
	solutionsFile: File | null;
}

const INITIAL_FORM: FormState = {
	step: "type",
	resourceType: null,
	resourceName: "",
	files: [],
	hasMarkScheme: false,
	hasSolutions: false,
	splitMode: "auto",
	markSchemeFile: null,
	solutionsFile: null,
};

type FormAction =
	| { type: "reset" }
	| { type: "selectType"; value: ResourceType }
	| { type: "backToType" }
	| { type: "setName"; value: string }
	| { type: "addFiles"; files: File[] }
	| { type: "removeFile"; index: number }
	| { type: "setHasMarkScheme"; value: boolean }
	| { type: "setHasSolutions"; value: boolean }
	| { type: "setSplitMode"; value: FormState["splitMode"] }
	| { type: "setMarkSchemeFile"; file: File | null }
	| { type: "setSolutionsFile"; file: File | null };

function formReducer(state: FormState, action: FormAction): FormState {
	switch (action.type) {
		case "reset":
			return INITIAL_FORM;
		case "selectType":
			return {
				...state,
				step: "details",
				resourceType: action.value,
				splitMode: action.value === "LECTURE_NOTES" ? "split" : state.splitMode,
			};
		case "backToType":
			return { ...state, step: "type", files: [] };
		case "setName":
			return { ...state, resourceName: action.value };
		case "addFiles":
			return { ...state, files: [...state.files, ...action.files] };
		case "removeFile":
			return { ...state, files: state.files.filter((_, i) => i !== action.index) };
		case "setHasMarkScheme":
			return { ...state, hasMarkScheme: action.value };
		case "setHasSolutions":
			return { ...state, hasSolutions: action.value };
		case "setSplitMode":
			return { ...state, splitMode: action.value };
		case "setMarkSchemeFile":
			return { ...state, markSchemeFile: action.file };
		case "setSolutionsFile":
			return { ...state, solutionsFile: action.file };
	}
}

interface ResourceUploadProps {
	sessionId: string;
	existingResources?: Resource[];
}

export function ResourceUpload({ sessionId, existingResources }: ResourceUploadProps) {
	const queryClient = useQueryClient();
	const [isOpen, setIsOpen] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [form, dispatch] = useReducer(formReducer, INITIAL_FORM);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const existingLectureNotes = existingResources?.find((r) => r.type === "LECTURE_NOTES");
	const isAddingToExisting = form.resourceType === "LECTURE_NOTES" && !!existingLectureNotes;
	const allowMultipleFiles = form.resourceType === "LECTURE_NOTES";

	const handleOpen = () => {
		dispatch({ type: "reset" });
		setIsOpen(true);
	};

	const handleClose = () => {
		if (!uploading) {
			setIsOpen(false);
			dispatch({ type: "reset" });
		}
	};

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files) {
			const newFiles = Array.from(e.target.files);
			dispatch({
				type: "addFiles",
				files: allowMultipleFiles ? newFiles : newFiles.slice(0, 1),
			});
		}
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	const handleSubmit = useCallback(async () => {
		if (!form.resourceType || form.files.length === 0) return;
		setUploading(true);
		try {
			const name =
				form.resourceName || form.files.map((f) => f.name.replace(/\.[^.]+$/, "")).join(", ");

			let label: string | undefined;
			if (form.resourceType === "PAST_PAPER" && form.hasMarkScheme) {
				label = "includes_mark_scheme";
			} else if (form.resourceType === "PROBLEM_SHEET" && form.hasSolutions) {
				label = "includes_solutions";
			}

			await createResource(sessionId, {
				name,
				type: form.resourceType,
				label,
				splitMode: form.splitMode !== "auto" ? form.splitMode : undefined,
				files: form.files,
				markScheme: form.markSchemeFile ?? undefined,
				solutions: form.solutionsFile ?? undefined,
			});

			log.info("ResourceUpload — resource created");
			queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
			setIsOpen(false);
			dispatch({ type: "reset" });
		} catch (err) {
			log.error("ResourceUpload — upload error", err);
		} finally {
			setUploading(false);
		}
	}, [form, sessionId, queryClient]);

	return (
		<>
			<button
				type="button"
				onClick={handleOpen}
				className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
			>
				<Plus className="h-4 w-4" />
				Add Resource
			</button>

			{isOpen && (
				<Modal onClose={handleClose}>
					{form.step === "type" && (
						<TypeStep
							existingLectureNotes={!!existingLectureNotes}
							onSelect={(t) => dispatch({ type: "selectType", value: t })}
						/>
					)}

					{form.step === "details" && form.resourceType && (
						<DetailsStep
							form={form}
							dispatch={dispatch}
							isAddingToExisting={isAddingToExisting}
							allowMultipleFiles={allowMultipleFiles}
							fileInputRef={fileInputRef}
							onFileChange={handleFileChange}
							onSubmit={handleSubmit}
							uploading={uploading}
						/>
					)}
				</Modal>
			)}
		</>
	);
}

function TypeStep({
	existingLectureNotes,
	onSelect,
}: {
	existingLectureNotes: boolean;
	onSelect: (type: ResourceType) => void;
}) {
	return (
		<>
			<h2 className="mb-4 text-lg font-semibold">What are you uploading?</h2>
			<div className="space-y-2">
				{TYPE_OPTIONS.map((opt) => (
					<button
						type="button"
						key={opt.value}
						onClick={() => onSelect(opt.value)}
						className="flex w-full items-center justify-between rounded-md border border-border px-4 py-3 text-left transition-colors hover:border-primary hover:bg-primary/5"
					>
						<div>
							<div className="text-sm font-medium">{opt.label}</div>
							<div className="text-xs text-muted-foreground">
								{opt.value === "LECTURE_NOTES" && existingLectureNotes
									? "Add more files to existing lecture notes"
									: opt.description}
							</div>
						</div>
					</button>
				))}
			</div>
		</>
	);
}

function CheckboxField({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
}) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="h-4 w-4 rounded border-input"
			/>
			{label}
		</label>
	);
}

function TypeSpecificOptions({
	form,
	dispatch,
}: {
	form: FormState;
	dispatch: React.Dispatch<FormAction>;
}) {
	switch (form.resourceType) {
		case "PAST_PAPER":
			return (
				<>
					<CheckboxField
						checked={form.hasMarkScheme}
						onChange={(v) => dispatch({ type: "setHasMarkScheme", value: v })}
						label="PDF includes mark scheme"
					/>
					{!form.hasMarkScheme && (
						<SecondaryFilePicker
							id="mark-scheme-file"
							label="Mark Scheme"
							file={form.markSchemeFile}
							onFileChange={(f) => dispatch({ type: "setMarkSchemeFile", file: f })}
							onClear={() => dispatch({ type: "setMarkSchemeFile", file: null })}
							buttonLabel="Choose mark scheme PDF"
						/>
					)}
				</>
			);
		case "PROBLEM_SHEET":
			return (
				<>
					<CheckboxField
						checked={form.hasSolutions}
						onChange={(v) => dispatch({ type: "setHasSolutions", value: v })}
						label="PDF includes solutions"
					/>
					{!form.hasSolutions && (
						<SecondaryFilePicker
							id="solutions-file"
							label="Solutions"
							file={form.solutionsFile}
							onFileChange={(f) => dispatch({ type: "setSolutionsFile", file: f })}
							onClear={() => dispatch({ type: "setSolutionsFile", file: null })}
							buttonLabel="Choose solutions PDF"
						/>
					)}
				</>
			);
		case "LECTURE_NOTES":
			return (
				<CheckboxField
					checked={form.splitMode === "split"}
					onChange={(v) => dispatch({ type: "setSplitMode", value: v ? "split" : "auto" })}
					label="Split into chunks for indexing"
				/>
			);
		default:
			return null;
	}
}

function DetailsStep({
	form,
	dispatch,
	isAddingToExisting,
	allowMultipleFiles,
	fileInputRef,
	onFileChange,
	onSubmit,
	uploading,
}: {
	form: FormState;
	dispatch: React.Dispatch<FormAction>;
	isAddingToExisting: boolean;
	allowMultipleFiles: boolean;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onSubmit: () => void;
	uploading: boolean;
}) {
	return (
		<>
			<h2 className="mb-4 text-lg font-semibold">
				{isAddingToExisting
					? "Add to Lecture Notes"
					: `New ${(form.resourceType && TYPE_LABELS[form.resourceType]) || form.resourceType}`}
			</h2>

			<div className="space-y-4">
				{!isAddingToExisting && (
					<div>
						<label htmlFor="resource-name" className="mb-1 block text-sm font-medium">
							Name <span className="font-normal text-muted-foreground">(optional)</span>
						</label>
						<input
							id="resource-name"
							type="text"
							value={form.resourceName}
							onChange={(e) => dispatch({ type: "setName", value: e.target.value })}
							placeholder="Defaults to filename"
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</div>
				)}

				<TypeSpecificOptions form={form} dispatch={dispatch} />

				<FilePicker
					files={form.files}
					allowMultiple={allowMultipleFiles}
					fileInputRef={fileInputRef}
					onFileChange={onFileChange}
					onRemoveFile={(i) => dispatch({ type: "removeFile", index: i })}
				/>

				<div className="flex items-center justify-between pt-2">
					<button
						type="button"
						onClick={() => dispatch({ type: "backToType" })}
						className="text-sm text-muted-foreground hover:text-foreground"
					>
						Back
					</button>
					<button
						type="button"
						onClick={onSubmit}
						disabled={form.files.length === 0 || uploading}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
					>
						{uploading ? "Uploading..." : "Upload"}
					</button>
				</div>
			</div>
		</>
	);
}

function FilePicker({
	files,
	allowMultiple,
	fileInputRef,
	onFileChange,
	onRemoveFile,
}: {
	files: File[];
	allowMultiple: boolean;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
	onRemoveFile: (index: number) => void;
}) {
	return (
		<div>
			<label htmlFor="resource-file" className="mb-1 block text-sm font-medium">
				{allowMultiple ? "Files" : "File"}
			</label>

			{files.length > 0 && (
				<div className="mb-2 space-y-1">
					{files.map((file, i) => (
						<FileChip key={`${file.name}-${i}`} name={file.name} onRemove={() => onRemoveFile(i)} />
					))}
				</div>
			)}

			{(allowMultiple || files.length === 0) && (
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
				>
					<Upload className="h-4 w-4" />
					{files.length > 0 ? "Add more files" : "Choose file"}
				</button>
			)}

			<input
				id="resource-file"
				ref={fileInputRef}
				type="file"
				accept=".pdf"
				multiple={allowMultiple}
				onChange={onFileChange}
				className="hidden"
			/>
		</div>
	);
}
