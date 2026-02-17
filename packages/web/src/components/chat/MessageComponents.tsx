import {
	ActionBarPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	useAttachmentRuntime,
	useMessage,
	useMessagePartImage,
	useMessageRuntime,
} from "@assistant-ui/react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { CodeHeaderProps } from "@assistant-ui/react-markdown";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	ClipboardCopy,
	Loader2,
	Pencil,
	RefreshCw,
	RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

// ─── Tool label mapping ───

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
	mcp__cramkit__search_notes: (a) => `Searched notes for "${a.query ?? ""}"`,
	mcp__cramkit__get_resource_content: () => "Read resource content",
	mcp__cramkit__get_resource_info: () => "Read resource info",
	mcp__cramkit__get_resource_index: () => "Read resource index",
	mcp__cramkit__get_chunk: () => "Read content chunk",
	mcp__cramkit__list_concepts: () => "Listed concepts",
	mcp__cramkit__get_concept: () => "Read concept details",
	mcp__cramkit__get_related: () => "Found related items",
	mcp__cramkit__create_link: () => "Created knowledge link",
	mcp__cramkit__list_sessions: () => "Listed sessions",
	mcp__cramkit__get_session: () => "Read session details",
	mcp__cramkit__get_exam_scope: () => "Read exam scope",
	mcp__cramkit__list_past_papers: () => "Listed past papers",
	mcp__cramkit__list_problem_sheets: () => "Listed problem sheets",
	mcp__cramkit__get_past_paper: () => "Read past paper",
	Read: (a) => {
		const path = typeof a.file_path === "string" ? a.file_path : "";
		const name = path.split("/").pop() || path;
		return name ? `Read file: ${name}` : "Read file";
	},
	mcp__images__view_image: (a) => {
		const path = typeof a.file_path === "string" ? a.file_path : "";
		const name = path.split("/").pop() || "image";
		return `Viewing ${name}`;
	},
};

export function getToolLabel(toolName: string, args: Record<string, unknown>): string {
	const fn = TOOL_LABELS[toolName];
	if (fn) return fn(args);
	const short = toolName.replace(/^mcp__cramkit__/, "");
	return short.replace(/_/g, " ");
}

// ─── Tool Call Display ───

export function ToolCallDisplay(props: ToolCallMessagePartProps) {
	const { toolName, args, result, isError } = props;
	const [expanded, setExpanded] = useState(false);
	const hasResult = result !== undefined;
	const label = getToolLabel(toolName, args);

	return (
		<div className="my-1.5 rounded-lg border border-border bg-background text-sm">
			<button
				type="button"
				onClick={() => hasResult && setExpanded(!expanded)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors rounded-lg"
				disabled={!hasResult}
			>
				{isError ? (
					<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
				) : hasResult ? (
					<Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
				) : (
					<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
				)}
				<span
					className={`flex-1 truncate ${isError ? "text-destructive" : "text-muted-foreground"}`}
				>
					{hasResult ? label : `${label}...`}
				</span>
				{hasResult &&
					(expanded ? (
						<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					))}
			</button>
			{expanded && hasResult && (
				<div className="border-t border-border px-3 py-2">
					<pre className="max-h-48 overflow-auto text-xs text-muted-foreground whitespace-pre-wrap break-all">
						{typeof result === "string" ? result : JSON.stringify(result, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}

// ─── Reasoning Display ───

export function ReasoningDisplay({ text }: { type: "reasoning"; text: string; status?: unknown }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="my-1.5 rounded-lg border border-border bg-amber-50/50 dark:bg-amber-950/20 text-sm">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors rounded-lg"
			>
				<span className="text-amber-600 dark:text-amber-400 text-xs font-medium">Thinking</span>
				<span className="flex-1" />
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				)}
			</button>
			{expanded && (
				<div className="border-t border-border px-3 py-2">
					<pre className="max-h-64 overflow-auto text-xs text-muted-foreground whitespace-pre-wrap">
						{text}
					</pre>
				</div>
			)}
		</div>
	);
}

// ─── Code block copy button ───

export function CodeHeader({ code }: CodeHeaderProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = () => {
		navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	};

	return (
		<div className="flex items-center justify-end -mb-2 px-1">
			<button
				type="button"
				onClick={handleCopy}
				className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
				title="Copy code"
			>
				{copied ? (
					<Check className="h-3.5 w-3.5 text-green-600" />
				) : (
					<ClipboardCopy className="h-3.5 w-3.5" />
				)}
			</button>
		</div>
	);
}

// ─── Message Components ───

function UserImagePart() {
	const image = useMessagePartImage();
	const [enlarged, setEnlarged] = useState(false);
	if (!image?.image) return null;
	return (
		<>
			<button type="button" onClick={() => setEnlarged(true)} className="block">
				<img
					src={image.image}
					alt=""
					className="max-h-64 rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
				/>
			</button>
			{enlarged && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
					onClick={() => setEnlarged(false)}
					onKeyDown={(e) => e.key === "Escape" && setEnlarged(false)}
				>
					<img
						src={image.image}
						alt=""
						className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
					/>
				</div>
			)}
		</>
	);
}

function UserMessageAttachment() {
	const [enlarged, setEnlarged] = useState(false);
	const attachmentRuntime = useAttachmentRuntime();
	const state = attachmentRuntime.getState();

	if (state.type !== "image") return null;

	const imageUrl = `/api/chat/attachments/${state.id}`;

	return (
		<>
			<button type="button" onClick={() => setEnlarged(true)} className="block">
				<img
					src={imageUrl}
					alt={state.name}
					className="max-h-64 rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
				/>
			</button>
			{enlarged && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
					onClick={() => setEnlarged(false)}
					onKeyDown={(e) => e.key === "Escape" && setEnlarged(false)}
				>
					<img
						src={imageUrl}
						alt={state.name}
						className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl"
					/>
				</div>
			)}
		</>
	);
}

function formatTimestamp(date: Date): string {
	return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function MessageTimestamp() {
	const createdAt = useMessage((m) => m.createdAt);
	if (!createdAt) return null;
	return (
		<span className="text-xs text-muted-foreground/60 select-none">
			{formatTimestamp(createdAt)}
		</span>
	);
}

function MarkdownText() {
	return (
		<MarkdownTextPrimitive
			remarkPlugins={[remarkGfm, remarkMath]}
			rehypePlugins={[rehypeKatex]}
			components={{
				CodeHeader,
			}}
		/>
	);
}

// ─── Retry with Confirmation ───

function RewindConfirmDialog({
	open,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	useEffect(() => {
		if (!open) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCancel();
		};
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [open, onCancel]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onCancel}
			onKeyDown={(e) => e.key === "Escape" && onCancel()}
		>
			<div
				className="rounded-xl border border-border bg-background p-6 shadow-lg max-w-sm mx-4"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<h3 className="font-semibold text-sm mb-2">Retry from here?</h3>
				<p className="text-sm text-muted-foreground mb-4">
					This will delete all messages after this point and regenerate the response. This cannot be
					undone.
				</p>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 transition-colors"
					>
						Retry
					</button>
				</div>
			</div>
		</div>
	);
}

function RetryButton() {
	const [showConfirm, setShowConfirm] = useState(false);
	const messageRuntime = useMessageRuntime();

	return (
		<>
			<button
				type="button"
				onClick={() => setShowConfirm(true)}
				className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
				title="Retry from here"
			>
				<RotateCcw className="h-4 w-4" />
			</button>
			<RewindConfirmDialog
				open={showConfirm}
				onConfirm={() => {
					setShowConfirm(false);
					messageRuntime.reload();
				}}
				onCancel={() => setShowConfirm(false)}
			/>
		</>
	);
}

// ─── Exported message components for ThreadPrimitive ───

export function UserMessage() {
	return (
		<MessagePrimitive.Root className="group flex justify-end px-4 py-2">
			<div className="flex flex-col items-end gap-1 max-w-[80%]">
				<MessagePrimitive.Attachments
					components={{
						Image: UserMessageAttachment,
						File: UserMessageAttachment,
						Attachment: UserMessageAttachment,
					}}
				/>
				<div className="rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
					<MessagePrimitive.Content components={{ Image: UserImagePart }} />
				</div>
				<div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
					<MessageTimestamp />
					<ActionBarPrimitive.Root className="flex items-center gap-1">
						<RetryButton />
						<ActionBarPrimitive.Edit className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
							<Pencil className="h-4 w-4" />
						</ActionBarPrimitive.Edit>
						<ActionBarPrimitive.Copy
							copiedDuration={2000}
							className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						>
							<ClipboardCopy className="h-4 w-4" />
						</ActionBarPrimitive.Copy>
					</ActionBarPrimitive.Root>
				</div>
			</div>
		</MessagePrimitive.Root>
	);
}

export function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="group flex px-4 py-2">
			<div className="flex flex-col gap-1 max-w-full">
				<div className="prose prose-sm max-w-none rounded-2xl bg-muted px-4 py-2">
					<MessagePrimitive.Content
						components={{
							Text: MarkdownText,
							Reasoning: ReasoningDisplay,
							tools: {
								Fallback: ToolCallDisplay,
							},
						}}
					/>
				</div>
				<div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
					<MessageTimestamp />
					<ActionBarPrimitive.Root className="flex items-center gap-1">
						<ActionBarPrimitive.Copy
							copiedDuration={2000}
							className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						>
							<ClipboardCopy className="h-4 w-4" />
						</ActionBarPrimitive.Copy>
						<ActionBarPrimitive.Reload className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
							<RefreshCw className="h-4 w-4" />
						</ActionBarPrimitive.Reload>
					</ActionBarPrimitive.Root>
				</div>
			</div>
		</MessagePrimitive.Root>
	);
}

export function EditComposer() {
	return (
		<ComposerPrimitive.Root className="flex flex-col gap-2 rounded-2xl border border-border bg-background p-3 max-w-[80%]">
			<ComposerPrimitive.Input className="flex-1 resize-none bg-transparent text-sm outline-none min-h-[60px]" />
			<div className="flex items-center gap-2 justify-end">
				<ComposerPrimitive.Cancel className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
					Cancel
				</ComposerPrimitive.Cancel>
				<ComposerPrimitive.Send className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
					Save & Regenerate
				</ComposerPrimitive.Send>
			</div>
		</ComposerPrimitive.Root>
	);
}
