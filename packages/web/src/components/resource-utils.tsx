import { Upload, X } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";

export type ResourceType =
	| "LECTURE_NOTES"
	| "PAST_PAPER"
	| "PROBLEM_SHEET"
	| "SPECIFICATION"
	| "OTHER";

export const TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-800",
	PAST_PAPER: "bg-amber-100 text-amber-800",
	PROBLEM_SHEET: "bg-purple-100 text-purple-800",
	SPECIFICATION: "bg-gray-100 text-gray-800",
	OTHER: "bg-gray-100 text-gray-800",
};

export const TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Lecture Notes",
	PAST_PAPER: "Past Paper",
	PROBLEM_SHEET: "Problem Sheet",
	SPECIFICATION: "Specification",
	OTHER: "Other",
};

export const ROLE_LABELS: Record<string, string> = {
	PRIMARY: "Primary",
	MARK_SCHEME: "Mark Scheme",
	SOLUTIONS: "Solutions",
	SUPPLEMENT: "Supplement",
};

export function TypeBadge({ type }: { type: string }) {
	return (
		<span
			className={`rounded-full px-2 py-0.5 text-xs font-medium ${
				TYPE_COLORS[type] || TYPE_COLORS.OTHER
			}`}
		>
			{TYPE_LABELS[type] || type}
		</span>
	);
}

export function FileChip({
	name,
	onRemove,
}: {
	name: string;
	onRemove?: () => void;
}) {
	return (
		<div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
			<span className="truncate">{name}</span>
			{onRemove && (
				<button
					type="button"
					onClick={onRemove}
					className="ml-2 text-muted-foreground hover:text-destructive"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}

export function SecondaryFilePicker({
	id,
	label,
	file,
	onFileChange,
	onClear,
	buttonLabel,
}: {
	id: string;
	label: string;
	file: File | null;
	onFileChange: (file: File) => void;
	onClear: () => void;
	buttonLabel: string;
}) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-sm font-medium">
				{label} <span className="font-normal text-muted-foreground">(optional)</span>
			</label>
			{file ? (
				<FileChip name={file.name} onRemove={onClear} />
			) : (
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
				>
					<Upload className="h-4 w-4" />
					{buttonLabel}
				</button>
			)}
			<input
				id={id}
				ref={inputRef}
				type="file"
				accept=".pdf"
				onChange={(e) => {
					if (e.target.files?.[0]) onFileChange(e.target.files[0]);
					if (inputRef.current) inputRef.current.value = "";
				}}
				className="hidden"
			/>
		</div>
	);
}

export function Modal({
	onClose,
	children,
}: {
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onClose}
			onKeyDown={onClose}
			role="presentation"
		>
			<div
				className="relative w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-lg"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
				role="presentation"
			>
				<button
					type="button"
					onClick={onClose}
					className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:text-foreground"
				>
					<X className="h-4 w-4" />
				</button>
				{children}
			</div>
		</div>
	);
}
