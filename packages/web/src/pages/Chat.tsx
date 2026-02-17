import {
	type ConversationSummary,
	createConversation,
	deleteConversation,
	fetchConversations,
	fetchMessages,
	fetchSession,
	renameConversation,
} from "@/lib/api";
import { chatAttachmentAdapter, createCramKitChatAdapter } from "@/lib/chat-adapter";
import {
	AssistantRuntimeProvider,
	AttachmentPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useComposerRuntime,
	useLocalRuntime,
	useMessagePartImage,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "katex/dist/katex.min.css";
import {
	ArrowLeft,
	Check,
	MessageSquare,
	Paperclip,
	Pencil,
	Plus,
	Send,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

function UserImagePart() {
	const image = useMessagePartImage();
	if (!image?.image) return null;
	return <img src={image.image} alt="" className="max-h-64 rounded-lg" />;
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="flex justify-end px-4 py-2">
			<div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
				<MessagePrimitive.Content components={{ Image: UserImagePart }} />
			</div>
		</MessagePrimitive.Root>
	);
}

function MarkdownText() {
	return <MarkdownTextPrimitive remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]} />;
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="flex px-4 py-2">
			<div className="prose prose-sm max-w-[80%] rounded-2xl bg-muted px-4 py-2">
				<MessagePrimitive.Content components={{ Text: MarkdownText }} />
			</div>
		</MessagePrimitive.Root>
	);
}

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
			// Re-add attachments (they're already uploaded on the server)
			for (const att of draft.attachments) {
				const fakeFile = new File([], att.name, { type: att.contentType });
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

function ComposerImageAttachment() {
	return (
		<AttachmentPrimitive.Root className="relative inline-block m-2">
			<AttachmentPrimitive.unstable_Thumb className="h-16 w-16 overflow-hidden rounded-lg border border-border" />
			<AttachmentPrimitive.Remove className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background border border-border text-muted-foreground hover:text-foreground text-xs">
				<X className="h-3 w-3" />
			</AttachmentPrimitive.Remove>
		</AttachmentPrimitive.Root>
	);
}

function ChatThread({
	sessionId,
	conversationId,
}: {
	sessionId: string;
	conversationId: string;
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
							{ type: "text"; text: string } | { type: "image"; image: string }
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

						// Add text content
						contentParts.push({ type: "text", text: m.content });

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

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<DraftPersistence conversationId={conversationId} />
			<div className="flex h-full min-h-0 flex-col">
				<ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
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
							}}
						/>
					</ThreadPrimitive.Viewport>

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
								<ComposerPrimitive.Send className="rounded-lg bg-primary p-2 text-primary-foreground hover:opacity-90 disabled:opacity-50">
									<Send className="h-4 w-4" />
								</ComposerPrimitive.Send>
							</div>
						</ComposerPrimitive.Root>
					</div>
				</ThreadPrimitive.Root>
			</div>
		</AssistantRuntimeProvider>
	);
}

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
		<button
			type="button"
			onClick={onSelect}
			className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
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
		</button>
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
	const activeIdRef = useRef(activeConversationId);
	activeIdRef.current = activeConversationId;

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
	});

	const cleanupEmpty = useCallback(
		async (convId: string | null) => {
			if (!convId) return;
			try {
				const msgs = await fetchMessages(convId);
				if (msgs.length === 0) {
					await deleteConversation(convId);
					queryClient.invalidateQueries({
						queryKey: ["conversations", sessionId],
					});
				}
			} catch {
				// conversation may already be deleted
			}
		},
		[sessionId, queryClient],
	);

	const handleSelectConversation = useCallback(
		(convId: string) => {
			const prev = activeIdRef.current;
			setSearchParams({ c: convId });
			if (prev && prev !== convId) {
				cleanupEmpty(prev);
			}
		},
		[setSearchParams, cleanupEmpty],
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
							key={activeConversationId}
							sessionId={sessionId}
							conversationId={activeConversationId}
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
