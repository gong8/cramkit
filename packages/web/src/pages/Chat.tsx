import {
	type ConversationSummary,
	type ToolCallData,
	createConversation,
	deleteConversation,
	fetchConversations,
	fetchMessages,
	fetchSession,
	fetchStreamStatus,
	renameConversation,
} from "@/lib/api";
import { chatAttachmentAdapter, createCramKitChatAdapter } from "@/lib/chat-adapter";
import {
	ActionBarPrimitive,
	AssistantRuntimeProvider,
	AttachmentPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useAttachmentRuntime,
	useComposerRuntime,
	useLocalRuntime,
	useMessagePartImage,
	useThreadRuntime,
} from "@assistant-ui/react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { type CodeHeaderProps, MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "katex/dist/katex.min.css";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	ChevronDown,
	ChevronRight,
	ClipboardCopy,
	Download,
	Loader2,
	MessageSquare,
	Paperclip,
	Pencil,
	Plus,
	RefreshCw,
	Send,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
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
};

function getToolLabel(toolName: string, args: Record<string, unknown>): string {
	const fn = TOOL_LABELS[toolName];
	if (fn) return fn(args);
	// Strip mcp__cramkit__ prefix for unknown tools
	const short = toolName.replace(/^mcp__cramkit__/, "");
	return short.replace(/_/g, " ");
}

// ─── Tool Call Display ───

function ToolCallDisplay(props: ToolCallMessagePartProps) {
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

function ReasoningDisplay({ text }: { type: "reasoning"; text: string; status?: unknown }) {
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

function CodeHeader({ code }: CodeHeaderProps) {
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

	// Only handle image attachments
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

function UserMessage() {
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
				<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
					<ActionBarPrimitive.Root className="flex items-center gap-0.5">
						<ActionBarPrimitive.Edit className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
							<Pencil className="h-3 w-3" />
						</ActionBarPrimitive.Edit>
						<ActionBarPrimitive.Copy
							copiedDuration={2000}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						>
							<ClipboardCopy className="h-3 w-3" />
						</ActionBarPrimitive.Copy>
					</ActionBarPrimitive.Root>
				</div>
			</div>
		</MessagePrimitive.Root>
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

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="group flex px-4 py-2">
			<div className="flex flex-col gap-1 max-w-full">
				<div className="prose prose-sm rounded-2xl bg-muted px-4 py-2">
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
				<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
					<ActionBarPrimitive.Root className="flex items-center gap-0.5">
						<ActionBarPrimitive.Copy
							copiedDuration={2000}
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						>
							<ClipboardCopy className="h-3 w-3" />
						</ActionBarPrimitive.Copy>
						<ActionBarPrimitive.Reload className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
							<RefreshCw className="h-3 w-3" />
						</ActionBarPrimitive.Reload>
					</ActionBarPrimitive.Root>
				</div>
			</div>
		</MessagePrimitive.Root>
	);
}

function EditComposer() {
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

// ─── Draft Persistence ───

interface DraftData {
	text: string;
	attachments: Array<{ id: string; name: string; contentType: string }>;
}

function getDraftKey(conversationId: string) {
	return `chat-draft::${conversationId}`;
}

function DraftPersistence({ conversationId }: { conversationId: string }) {
	const composerRuntime = useComposerRuntime();
	const draftKey = getDraftKey(conversationId);

	// Restore draft on mount only — intentionally omitting deps
	// biome-ignore lint/correctness/useExhaustiveDependencies: restore only once on mount
	useEffect(() => {
		const raw = sessionStorage.getItem(draftKey);
		if (!raw) return;
		try {
			const draft: DraftData = JSON.parse(raw);
			if (draft.text) {
				composerRuntime.setText(draft.text);
			}
			// Re-add attachments — use __restore__ prefix so the adapter skips re-uploading
			for (const att of draft.attachments) {
				const restoreName = `__restore__${att.id}__${att.name}`;
				const fakeFile = new File([], restoreName, { type: att.contentType });
				composerRuntime.addAttachment(fakeFile).catch(() => {});
			}
		} catch {
			// Invalid draft data, ignore
		}
	}, []);

	// Save draft periodically and on unmount
	useEffect(() => {
		const save = () => {
			const state = composerRuntime.getState();
			const draft: DraftData = {
				text: state.text,
				attachments: state.attachments.map((a) => ({
					id: a.id,
					name: a.name,
					contentType: a.contentType ?? "",
				})),
			};
			if (draft.text || draft.attachments.length > 0) {
				sessionStorage.setItem(draftKey, JSON.stringify(draft));
			} else {
				sessionStorage.removeItem(draftKey);
			}
		};

		const interval = setInterval(save, 2000);
		return () => {
			clearInterval(interval);
			save();
		};
	}, [composerRuntime, draftKey]);

	return null;
}

// ─── Composer Attachment ───

function ComposerImageAttachment() {
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const attachmentRuntime = useAttachmentRuntime();
	const state = attachmentRuntime.getState();

	useEffect(() => {
		// Try to create a preview from the file data
		const file = (state as { file?: File }).file;
		if (file && file.size > 0) {
			const url = URL.createObjectURL(file);
			setPreviewUrl(url);
			return () => URL.revokeObjectURL(url);
		}
		// Fall back to server URL (for restored drafts)
		if (state.id) {
			setPreviewUrl(`/api/chat/attachments/${state.id}`);
		}
	}, [state]);

	return (
		<AttachmentPrimitive.Root className="relative inline-block m-2">
			<div className="h-16 w-16 overflow-hidden rounded-lg border border-border bg-muted">
				{previewUrl ? (
					<img src={previewUrl} alt={state.name} className="h-full w-full object-cover" />
				) : (
					<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
						{state.name?.split(".").pop()?.toUpperCase() || "IMG"}
					</div>
				)}
			</div>
			<AttachmentPrimitive.Remove className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background border border-border text-muted-foreground hover:text-foreground text-xs">
				<X className="h-3 w-3" />
			</AttachmentPrimitive.Remove>
		</AttachmentPrimitive.Root>
	);
}

// ─── Stop Button ───

function StopButton() {
	const threadRuntime = useThreadRuntime();

	return (
		<button
			type="button"
			onClick={() => threadRuntime.cancelRun()}
			className="rounded-lg bg-destructive p-2 text-destructive-foreground hover:opacity-90 transition-colors"
			title="Stop generation (Escape)"
		>
			<Square className="h-4 w-4" />
		</button>
	);
}

// ─── Export Button ───

function ExportButton({
	sessionName,
	conversationId,
}: {
	sessionName: string;
	conversationId: string;
}) {
	const handleExport = async () => {
		const messages = await fetchMessages(conversationId);
		const date = new Date().toLocaleString();

		const lines = ["# Chat Export", `Session: ${sessionName}`, `Exported: ${date}`, "", "---", ""];

		for (const msg of messages) {
			const role = msg.role === "user" ? "User" : "Assistant";
			lines.push(`**${role}**: ${msg.content}`, "", "---", "");
		}

		const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.md`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<button
			type="button"
			onClick={handleExport}
			className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
			title="Export conversation as markdown"
		>
			<Download className="h-4 w-4" />
		</button>
	);
}

// ─── Reconnect Stream View ───

interface ReconnectStream {
	content: string;
	toolCalls: Map<
		string,
		{
			toolCallId: string;
			toolName: string;
			args?: Record<string, unknown>;
			result?: string;
			isError?: boolean;
		}
	>;
	thinkingText: string;
	done: boolean;
}

function ReconnectStreamView({ stream }: { stream: ReconnectStream }) {
	const cleanContent = stream.content
		.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
		.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
		.replace(/<tool_call[\s\S]*$/, "")
		.replace(/<tool_result[\s\S]*$/, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return (
		<div className="group flex px-4 py-2">
			<div className="flex flex-col gap-1 max-w-full">
				<div className="prose prose-sm rounded-2xl bg-muted px-4 py-2">
					{stream.thinkingText && (
						<ReasoningDisplay type="reasoning" text={stream.thinkingText} />
					)}
					{Array.from(stream.toolCalls.values()).map((tc) => {
						const hasResult = tc.result !== undefined;
						const label = getToolLabel(tc.toolName, tc.args ?? {});
						return (
							<div
								key={tc.toolCallId}
								className="my-1.5 rounded-lg border border-border bg-background text-sm"
							>
								<div className="flex items-center gap-2 px-3 py-2">
									{tc.isError ? (
										<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
									) : hasResult ? (
										<Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
									) : (
										<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
									)}
									<span
										className={`flex-1 truncate ${tc.isError ? "text-destructive" : "text-muted-foreground"}`}
									>
										{hasResult ? label : `${label}...`}
									</span>
								</div>
							</div>
						);
					})}
					{cleanContent && (
						<ReactMarkdown
							remarkPlugins={[remarkGfm, remarkMath]}
							rehypePlugins={[rehypeKatex]}
						>
							{cleanContent}
						</ReactMarkdown>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Chat Thread ───

function ChatThread({
	sessionId,
	conversationId,
	sessionName,
	onStreamReconnected,
}: {
	sessionId: string;
	conversationId: string;
	sessionName: string;
	onStreamReconnected?: () => void;
}) {
	const queryClient = useQueryClient();

	const adapter = useMemo(
		() => createCramKitChatAdapter(sessionId, conversationId),
		[sessionId, conversationId],
	);

	const history = useMemo(
		() =>
			({
				async load() {
					const messages = await fetchMessages(conversationId);

					// Build ExportedMessageRepository format with linear parent chain
					const repoMessages = messages.map((m, i) => {
						const contentParts: Array<
							| { type: "text"; text: string }
							| { type: "image"; image: string }
							| {
									type: "tool-call";
									toolCallId: string;
									toolName: string;
									args: Record<string, unknown>;
									argsText: string;
									result?: string;
									isError?: boolean;
							  }
						> = [];

						// Add image parts from attachments
						if (m.attachments && m.attachments.length > 0) {
							for (const att of m.attachments) {
								contentParts.push({
									type: "image",
									image: `/api/chat/attachments/${att.id}`,
								});
							}
						}

						// Parse and add tool call parts from DB
						if (m.toolCalls) {
							try {
								const toolCalls: ToolCallData[] = JSON.parse(m.toolCalls);
								for (const tc of toolCalls) {
									contentParts.push({
										type: "tool-call",
										toolCallId: tc.toolCallId,
										toolName: tc.toolName,
										args: tc.args,
										argsText: JSON.stringify(tc.args),
										result: tc.result,
										isError: tc.isError,
									});
								}
							} catch {
								// Invalid tool calls JSON, skip
							}
						}

						// Parse any <tool_call>/<tool_result> XML embedded in text
						const callRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
						const resultRe = /<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g;
						const xmlCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
						const xmlResults: string[] = [];
						let rm: RegExpExecArray | null;
						while ((rm = callRe.exec(m.content)) !== null) {
							try {
								const parsed = JSON.parse(rm[1]);
								xmlCalls.push({ name: parsed.name, args: parsed.arguments || {} });
							} catch {
								/* skip */
							}
						}
						while ((rm = resultRe.exec(m.content)) !== null) {
							xmlResults.push(rm[1].trim());
						}
						for (let j = 0; j < xmlCalls.length; j++) {
							contentParts.push({
								type: "tool-call",
								toolCallId: `hist_tc_${i}_${j}`,
								toolName: xmlCalls[j].name,
								args: xmlCalls[j].args,
								argsText: JSON.stringify(xmlCalls[j].args),
								result: xmlResults[j],
								isError: false,
							});
						}

						// Add text content with XML stripped
						const cleanContent = m.content
							.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
							.replace(/<tool_result>[\s\S]*?<\/tool_result>/g, "")
							.replace(/\n{3,}/g, "\n\n")
							.trim();
						contentParts.push({ type: "text", text: cleanContent });

						return {
							message: {
								id: m.id,
								role: m.role,
								content: contentParts,
								createdAt: new Date(m.createdAt),
								status: { type: "complete", reason: "stop" },
								attachments: [],
								metadata: { steps: [], custom: {} },
							},
							parentId: i === 0 ? null : messages[i - 1].id,
						};
					});

					return {
						headId: messages.length > 0 ? messages[messages.length - 1].id : null,
						messages: repoMessages,
					};
				},
				async append() {
					// After each message exchange, refresh the conversation list
					// so titles update
					queryClient.invalidateQueries({
						queryKey: ["conversations", sessionId],
					});
				},
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			}) as any,
		[conversationId, sessionId, queryClient],
	);

	const runtime = useLocalRuntime(adapter, {
		adapters: { attachments: chatAttachmentAdapter, history },
	});

	// Reconnect to an active background stream on mount or after tab becomes visible again
	const [reconnectStream, setReconnectStream] = useState<ReconnectStream | null>(null);
	const reconnectViewportRef = useRef<HTMLDivElement>(null);
	const reconnectAbortRef = useRef<AbortController | null>(null);
	const wasStreamingRef = useRef(false);

	const doReconnect = useCallback(async () => {
		// Abort any previous reconnect attempt
		reconnectAbortRef.current?.abort();
		const abort = new AbortController();
		reconnectAbortRef.current = abort;

		try {
			const status = await fetchStreamStatus(conversationId);
			if (abort.signal.aborted) return;

			if (!status.active || status.status !== "streaming") {
				// No active stream — if we were previously streaming (tab was backgrounded
				// while a stream was active), the stream finished while we were away;
				// reload to pick up persisted message. Otherwise do nothing.
				if (wasStreamingRef.current) {
					wasStreamingRef.current = false;
					setReconnectStream(null);
					onStreamReconnected?.();
				}
				return;
			}

			// Active background stream — reconnect via dedicated endpoint
			const response = await fetch(
				`/api/chat/conversations/${conversationId}/stream-reconnect`,
				{ method: "POST", signal: abort.signal },
			);

			if (!response.ok || abort.signal.aborted) return;

			const reader = response.body?.getReader();
			if (!reader) return;

			const state: ReconnectStream = {
				content: "",
				toolCalls: new Map(),
				thinkingText: "",
				done: false,
			};
			wasStreamingRef.current = true;
			setReconnectStream({ ...state });

			const decoder = new TextDecoder();
			let buffer = "";
			let currentEventType = "content";

			while (!abort.signal.aborted) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				let updated = false;

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					if (trimmed.startsWith("event: ")) {
						currentEventType = trimmed.slice(7);
						continue;
					}

					if (trimmed.startsWith("data: ")) {
						const data = trimmed.slice(6);
						if (data === "[DONE]") {
							state.done = true;
							break;
						}

						try {
							const parsed = JSON.parse(data);
							switch (currentEventType) {
								case "content":
									if (parsed.content) {
										state.content += parsed.content;
										updated = true;
									}
									break;
								case "tool_call_start": {
									const { toolCallId, toolName } = parsed;
									state.toolCalls.set(toolCallId, { toolCallId, toolName });
									updated = true;
									break;
								}
								case "tool_call_args": {
									const { toolCallId, args } = parsed;
									const tc = state.toolCalls.get(toolCallId);
									if (tc) tc.args = args;
									updated = true;
									break;
								}
								case "tool_result": {
									const { toolCallId, result, isError } = parsed;
									const tc = state.toolCalls.get(toolCallId);
									if (tc) {
										tc.result = result;
										tc.isError = isError;
									}
									updated = true;
									break;
								}
								case "thinking_delta":
									if (parsed.text) {
										state.thinkingText += parsed.text;
										updated = true;
									}
									break;
							}
						} catch {
							// skip unparseable
						}
						currentEventType = "content";
					}
				}

				if (updated && !abort.signal.aborted) {
					setReconnectStream({ ...state, toolCalls: new Map(state.toolCalls) });
					// Auto-scroll only if user is near the bottom
					const vp = reconnectViewportRef.current;
					if (vp) {
						const nearBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80;
						if (nearBottom) {
							vp.scrollTo({ top: vp.scrollHeight });
						}
					}
				}

				if (state.done) break;
			}

			// Stream finished — clear reconnect state and reload thread
			if (!abort.signal.aborted) {
				wasStreamingRef.current = false;
				setReconnectStream(null);
				onStreamReconnected?.();
			}
		} catch {
			if (!abort.signal.aborted) {
				wasStreamingRef.current = false;
				setReconnectStream(null);
			}
		}
	}, [conversationId, onStreamReconnected]);

	// Reconnect on mount
	useEffect(() => {
		doReconnect();
		return () => {
			reconnectAbortRef.current?.abort();
		};
	}, [doReconnect]);

	// Recover when tab becomes visible again (browser suspends SSE connections in background tabs)
	useEffect(() => {
		function handleVisibilityChange() {
			if (document.visibilityState === "visible") {
				doReconnect();
			}
		}
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, [doReconnect]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Stop generation if streaming
				try {
					runtime.thread.cancelRun();
				} catch {
					// Not streaming, ignore
				}
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [runtime]);

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<DraftPersistence conversationId={conversationId} />
			<div className="flex h-full min-h-0 flex-col">
				{/* Export button in top-right of chat area */}
				<div className="flex justify-end px-4 py-1">
					<ExportButton sessionName={sessionName} conversationId={conversationId} />
				</div>

				<ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<ThreadPrimitive.Viewport ref={reconnectViewportRef} className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
						<ThreadPrimitive.Empty>
							<div className="flex h-full items-center justify-center">
								<p className="text-muted-foreground">
									Ask me anything about your study materials...
								</p>
							</div>
						</ThreadPrimitive.Empty>
						<ThreadPrimitive.Messages
							components={{
								UserMessage,
								AssistantMessage,
								EditComposer,
							}}
						/>
						{reconnectStream && (
							<ReconnectStreamView stream={reconnectStream} />
						)}
					</ThreadPrimitive.Viewport>

					<ThreadPrimitive.ScrollToBottom className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background p-2 shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-all z-10 disabled:pointer-events-none disabled:opacity-0">
						<ChevronDown className="h-4 w-4" />
					</ThreadPrimitive.ScrollToBottom>

					<div className="shrink-0 border-t border-border p-4">
						<ComposerPrimitive.Root className="rounded-xl border border-input bg-background">
							<ComposerPrimitive.Attachments
								components={{
									Image: ComposerImageAttachment,
									File: ComposerImageAttachment,
									Attachment: ComposerImageAttachment,
								}}
							/>
							<div className="flex items-center gap-2 px-3 py-2">
								<ComposerPrimitive.AddAttachment className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
									<Paperclip className="h-4 w-4" />
								</ComposerPrimitive.AddAttachment>
								<ComposerPrimitive.Input
									placeholder="Type a message..."
									className="flex-1 resize-none bg-transparent text-sm outline-none"
									autoFocus
								/>
								<ThreadPrimitive.If running>
									<StopButton />
								</ThreadPrimitive.If>
								<ThreadPrimitive.If running={false}>
									<ComposerPrimitive.Send className="rounded-lg bg-primary p-2 text-primary-foreground hover:opacity-90 disabled:opacity-50">
										<Send className="h-4 w-4" />
									</ComposerPrimitive.Send>
								</ThreadPrimitive.If>
							</div>
						</ComposerPrimitive.Root>
					</div>
				</ThreadPrimitive.Root>
			</div>
		</AssistantRuntimeProvider>
	);
}

// ─── Conversation Sidebar ───

function groupByDate(conversations: ConversationSummary[]) {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86400000);
	const weekAgo = new Date(today.getTime() - 7 * 86400000);

	const groups: { label: string; items: ConversationSummary[] }[] = [
		{ label: "Today", items: [] },
		{ label: "Yesterday", items: [] },
		{ label: "This week", items: [] },
		{ label: "Older", items: [] },
	];

	for (const c of conversations) {
		const d = new Date(c.updatedAt);
		if (d >= today) groups[0].items.push(c);
		else if (d >= yesterday) groups[1].items.push(c);
		else if (d >= weekAgo) groups[2].items.push(c);
		else groups[3].items.push(c);
	}

	return groups.filter((g) => g.items.length > 0);
}

function ConversationItem({
	conv,
	isActive,
	onSelect,
	onDelete,
	sessionId,
}: {
	conv: ConversationSummary;
	isActive: boolean;
	onSelect: () => void;
	onDelete: () => void;
	sessionId: string;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(conv.title);
	const inputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	const renameMutation = useMutation({
		mutationFn: (title: string) => renameConversation(conv.id, title),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			setIsEditing(false);
		},
	});

	useEffect(() => {
		if (isEditing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isEditing]);

	const handleSubmit = () => {
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== conv.title) {
			renameMutation.mutate(trimmed);
		} else {
			setIsEditing(false);
			setEditValue(conv.title);
		}
	};

	if (isEditing) {
		return (
			<div className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1">
				<input
					ref={inputRef}
					value={editValue}
					onChange={(e) => setEditValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSubmit();
						if (e.key === "Escape") {
							setIsEditing(false);
							setEditValue(conv.title);
						}
					}}
					onBlur={handleSubmit}
					className="flex-1 bg-transparent text-sm outline-none min-w-0"
				/>
				<button
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
				>
					<Check className="h-3 w-3" />
				</button>
				<button
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						setIsEditing(false);
						setEditValue(conv.title);
					}}
					className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
				>
					<X className="h-3 w-3" />
				</button>
			</div>
		);
	}

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
				isActive ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50"
			}`}
		>
			<MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span className="flex-1 truncate">{conv.title}</span>
			<div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						setEditValue(conv.title);
						setIsEditing(true);
					}}
					className="rounded p-0.5 text-muted-foreground hover:text-foreground"
				>
					<Pencil className="h-3 w-3" />
				</button>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onDelete();
					}}
					className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
				>
					<Trash2 className="h-3 w-3" />
				</button>
			</div>
		</div>
	);
}

function ConversationSidebar({
	sessionId,
	activeId,
	onSelect,
}: {
	sessionId: string;
	activeId: string | null;
	onSelect: (id: string) => void;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const { data: conversations = [] } = useQuery({
		queryKey: ["conversations", sessionId],
		queryFn: () => fetchConversations(sessionId),
	});

	const createMutation = useMutation({
		mutationFn: () => createConversation(sessionId),
		onSuccess: (conv) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			onSelect(conv.id);
		},
	});

	const deleteMutation = useMutation({
		mutationFn: deleteConversation,
		onSuccess: (_, deletedId) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			if (activeId === deletedId) {
				const remaining = conversations.filter((c) => c.id !== deletedId);
				if (remaining.length > 0) {
					onSelect(remaining[0].id);
				} else {
					navigate(`/session/${sessionId}/chat`);
				}
			}
		},
	});

	const groups = groupByDate(conversations);

	return (
		<div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/30">
			<div className="p-3">
				<button
					type="button"
					onClick={() => createMutation.mutate()}
					disabled={createMutation.isPending}
					className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
				>
					<Plus className="h-4 w-4" />
					New chat
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{conversations.length === 0 && (
					<p className="px-2 py-4 text-center text-xs text-muted-foreground">
						No conversations yet
					</p>
				)}

				{groups.map((group) => (
					<div key={group.label} className="mb-3">
						<p className="px-2 py-1 text-xs font-medium text-muted-foreground">{group.label}</p>
						{group.items.map((conv) => (
							<ConversationItem
								key={conv.id}
								conv={conv}
								isActive={activeId === conv.id}
								onSelect={() => onSelect(conv.id)}
								onDelete={() => deleteMutation.mutate(conv.id)}
								sessionId={sessionId}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

// ─── Main Chat Page ───

export function Chat() {
	// Lock page scroll while chat is mounted
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);

	const { id, conversationId: paramConvId } = useParams<{
		id: string;
		conversationId?: string;
	}>();
	const sessionId = id as string;
	const [searchParams, setSearchParams] = useSearchParams();
	const queryClient = useQueryClient();
	// Use URL param or search param for conversation ID
	const activeConversationId = paramConvId || searchParams.get("c");

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
		refetchOnWindowFocus: false,
	});

	const { data: conversations = [], isFetching: conversationsFetching } = useQuery({
		queryKey: ["conversations", sessionId],
		queryFn: () => fetchConversations(sessionId),
		enabled: !!sessionId,
		refetchOnWindowFocus: false,
	});

	const navigate = useNavigate();

	// Validate: if activeConversationId is not in the loaded list, clear it.
	// Skip while fetching — a new conversation may not be in the list yet.
	useEffect(() => {
		if (!activeConversationId || conversationsFetching) return;
		const exists = conversations.some((c) => c.id === activeConversationId);
		if (!exists) {
			if (conversations.length > 0) {
				setSearchParams({ c: conversations[0].id }, { replace: true });
			} else {
				navigate(`/session/${sessionId}/chat`, { replace: true });
			}
		}
	}, [
		activeConversationId,
		conversations,
		conversationsFetching,
		sessionId,
		setSearchParams,
		navigate,
	]);

	// Proactive cleanup: on initial load only, delete empty conversations that aren't active and have no draft.
	// Runs once per page visit — re-running on every query change causes races with "New chat".
	const cleanupRanRef = useRef(false);
	useEffect(() => {
		if (conversations.length === 0 || conversationsFetching || cleanupRanRef.current) return;
		cleanupRanRef.current = true;
		const toDelete = conversations.filter((c) => {
			if (c.messageCount !== 0) return false;
			if (c.id === activeConversationId) return false;
			// Preserve if there's a draft with content
			const saved = sessionStorage.getItem(`chat-draft::${c.id}`);
			if (saved) {
				try {
					const draft = JSON.parse(saved);
					if (draft.text?.trim() || draft.attachments?.length > 0) return false;
				} catch {
					// ignore
				}
			}
			return true;
		});
		if (toDelete.length === 0) return;
		Promise.all(toDelete.map((c) => deleteConversation(c.id).catch(() => {}))).then(() => {
			queryClient.invalidateQueries({ queryKey: ["conversations", sessionId] });
		});
	}, [conversations, conversationsFetching, activeConversationId, sessionId, queryClient]);

	// When a background stream finishes and the ChatThread remounts,
	// bump this key so it reloads the persisted assistant message from DB.
	const [threadReloadKey, setThreadReloadKey] = useState(0);
	const handleStreamReconnected = useCallback(() => {
		setThreadReloadKey((k) => k + 1);
	}, []);

	const handleSelectConversation = useCallback(
		(convId: string) => {
			setSearchParams({ c: convId });
		},
		[setSearchParams],
	);

	if (isLoading) {
		return (
			<div className="flex h-screen items-center justify-center">
				<p className="text-muted-foreground">Loading...</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Header */}
			<div className="shrink-0 flex items-center gap-3 border-b border-border px-4 py-3">
				<Link
					to={`/session/${sessionId}`}
					className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<ArrowLeft className="h-5 w-5" />
				</Link>
				<div>
					<h1 className="text-sm font-semibold">{session?.name || "Chat"}</h1>
					{session?.module && <p className="text-xs text-muted-foreground">{session.module}</p>}
				</div>
			</div>

			{/* Body: sidebar + chat */}
			<div className="flex min-h-0 flex-1 overflow-hidden">
				<ConversationSidebar
					sessionId={sessionId}
					activeId={activeConversationId}
					onSelect={handleSelectConversation}
				/>

				<div className="min-h-0 flex-1 overflow-hidden">
					{activeConversationId ? (
						<ChatThread
							key={`${activeConversationId}-${threadReloadKey}`}
							sessionId={sessionId}
							conversationId={activeConversationId}
							sessionName={session?.name || "Chat"}
							onStreamReconnected={handleStreamReconnected}
						/>
					) : (
						<EmptyState sessionId={sessionId} onCreated={handleSelectConversation} />
					)}
				</div>
			</div>
		</div>
	);
}

function EmptyState({
	sessionId,
	onCreated,
}: {
	sessionId: string;
	onCreated: (id: string) => void;
}) {
	const queryClient = useQueryClient();

	const createMutation = useMutation({
		mutationFn: () => createConversation(sessionId),
		onSuccess: (conv) => {
			queryClient.invalidateQueries({
				queryKey: ["conversations", sessionId],
			});
			onCreated(conv.id);
		},
	});

	return (
		<div className="flex h-full flex-col items-center justify-center gap-4">
			<MessageSquare className="h-12 w-12 text-muted-foreground/40" />
			<div className="text-center">
				<p className="text-sm text-muted-foreground">Select a conversation or start a new one</p>
			</div>
			<button
				type="button"
				onClick={() => createMutation.mutate()}
				disabled={createMutation.isPending}
				className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
			>
				<Plus className="h-4 w-4" />
				New chat
			</button>
		</div>
	);
}
