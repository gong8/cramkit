import type { SessionSummary } from "@/lib/api";
import { BookOpen, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

type EditField = "name" | "module";

interface SessionCardProps {
	session: SessionSummary;
	onCommitEdit: (id: string, field: EditField, value: string) => Promise<void>;
	onRequestDelete: (id: string, name: string) => void;
}

function InlineEditInput({
	inputRef,
	value,
	onChange,
	onCommit,
	onCancel,
	placeholder,
	className,
}: {
	inputRef: React.RefObject<HTMLInputElement | null>;
	value: string;
	onChange: (value: string) => void;
	onCommit: () => void;
	onCancel: () => void;
	placeholder?: string;
	className: string;
}) {
	return (
		<input
			ref={inputRef}
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onBlur={onCommit}
			onKeyDown={(e) => {
				if (e.key === "Enter") onCommit();
				if (e.key === "Escape") onCancel();
			}}
			onClick={(e) => e.preventDefault()}
			placeholder={placeholder}
			className={className}
		/>
	);
}

export function SessionCard({ session, onCommitEdit, onRequestDelete }: SessionCardProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	const [editField, setEditField] = useState<EditField | null>(null);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [menuOpen]);

	useEffect(() => {
		if (editField) {
			setTimeout(() => editInputRef.current?.select(), 0);
		}
	}, [editField]);

	const startEdit = (field: EditField, currentValue: string) => {
		setMenuOpen(false);
		setEditField(field);
		setEditValue(currentValue);
	};

	const commitEdit = async () => {
		const field = editField;
		if (!field) return;
		setEditField(null);
		await onCommitEdit(session.id, field, editValue.trim());
	};

	const cancelEdit = () => setEditField(null);

	return (
		<div className="relative rounded-lg border border-border transition-colors hover:bg-accent">
			<Link to={`/session/${session.id}`} className="block p-4">
				{editField === "name" ? (
					<InlineEditInput
						inputRef={editInputRef}
						value={editValue}
						onChange={setEditValue}
						onCommit={commitEdit}
						onCancel={cancelEdit}
						className="w-full rounded border border-input bg-background px-1.5 py-0.5 font-semibold outline-none focus:ring-1 focus:ring-ring"
					/>
				) : (
					<h2 className="font-semibold">{session.name}</h2>
				)}
				{editField === "module" ? (
					<InlineEditInput
						inputRef={editInputRef}
						value={editValue}
						onChange={setEditValue}
						onCommit={commitEdit}
						onCancel={cancelEdit}
						placeholder="Module code"
						className="mt-1 w-full rounded border border-input bg-background px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
					/>
				) : (
					session.module && <p className="mt-1 text-sm text-muted-foreground">{session.module}</p>
				)}
				<div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
					<span>
						{session.resourceCount} resource
						{session.resourceCount !== 1 ? "s" : ""}
					</span>
					{session.examDate && <span>Exam: {new Date(session.examDate).toLocaleDateString()}</span>}
				</div>
			</Link>

			<div className="absolute right-2 top-2" ref={menuRef}>
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setMenuOpen(!menuOpen);
					}}
					className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<MoreVertical className="h-4 w-4" />
				</button>

				{menuOpen && (
					<div className="absolute right-0 top-8 z-10 w-44 rounded-md border border-border bg-background py-1 shadow-lg">
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								startEdit("name", session.name);
							}}
							className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
						>
							<Pencil className="h-3.5 w-3.5" />
							Rename
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								startEdit("module", session.module ?? "");
							}}
							className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
						>
							<BookOpen className="h-3.5 w-3.5" />
							Change Module
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setMenuOpen(false);
								onRequestDelete(session.id, session.name);
							}}
							className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
						>
							<Trash2 className="h-3.5 w-3.5" />
							Delete
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
