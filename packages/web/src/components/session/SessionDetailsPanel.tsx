import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

interface SessionDetailsPanelProps {
	scope: string;
	onScopeChange: (value: string) => void;
	notes: string;
	onNotesChange: (value: string) => void;
	examDate: string;
	onExamDateChange: (value: string) => void;
}

function DetailField({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<label
				htmlFor={id}
				className="mb-1 block text-xs font-semibold uppercase text-muted-foreground"
			>
				{label}
			</label>
			{children}
		</div>
	);
}

export function SessionDetailsPanel({
	scope,
	onScopeChange,
	notes,
	onNotesChange,
	examDate,
	onExamDateChange,
}: SessionDetailsPanelProps) {
	const [open, setOpen] = useState(false);

	return (
		<div className="mb-6 rounded-lg border border-border">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent/50"
			>
				{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
				Session Details
			</button>
			{open && (
				<div className="space-y-4 border-t border-border px-4 py-4">
					<DetailField id="scope" label="Exam Scope">
						<textarea
							id="scope"
							value={scope}
							onChange={(e) => onScopeChange(e.target.value)}
							placeholder="Describe what's covered in the exam..."
							rows={3}
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</DetailField>
					<DetailField id="examDate" label="Exam Date">
						<input
							id="examDate"
							type="date"
							value={examDate}
							onChange={(e) => onExamDateChange(e.target.value)}
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</DetailField>
					<DetailField id="notes" label="Notes">
						<textarea
							id="notes"
							value={notes}
							onChange={(e) => onNotesChange(e.target.value)}
							placeholder="Any additional notes..."
							rows={3}
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</DetailField>
				</div>
			)}
		</div>
	);
}
