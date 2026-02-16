import { createCramKitChatAdapter } from "@/lib/chat-adapter";
import { fetchSession } from "@/lib/api";
import {
	AssistantRuntimeProvider,
	useLocalRuntime,
	ThreadPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Send } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

function UserMessage() {
	return (
		<MessagePrimitive.Root className="flex justify-end px-4 py-2">
			<div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
				<MessagePrimitive.Content />
			</div>
		</MessagePrimitive.Root>
	);
}

function MarkdownText() {
	return <MarkdownTextPrimitive />;
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

function ChatThread({ sessionId }: { sessionId: string }) {
	const adapter = useMemo(
		() => createCramKitChatAdapter(sessionId),
		[sessionId],
	);

	const runtime = useLocalRuntime(adapter);

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className="flex h-full flex-col">
				<ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
					<ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
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

					<div className="border-t border-border p-4">
						<ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-input bg-background px-3 py-2">
							<ComposerPrimitive.Input
								placeholder="Type a message..."
								className="flex-1 resize-none bg-transparent text-sm outline-none"
								autoFocus
							/>
							<ComposerPrimitive.Send className="rounded-lg bg-primary p-2 text-primary-foreground hover:opacity-90 disabled:opacity-50">
								<Send className="h-4 w-4" />
							</ComposerPrimitive.Send>
						</ComposerPrimitive.Root>
					</div>
				</ThreadPrimitive.Root>
			</div>
		</AssistantRuntimeProvider>
	);
}

export function Chat() {
	const { id } = useParams<{ id: string }>();
	const sessionId = id as string;

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
	});

	if (isLoading) {
		return (
			<div className="flex h-screen items-center justify-center">
				<p className="text-muted-foreground">Loading...</p>
			</div>
		);
	}

	return (
		<div className="flex h-screen flex-col">
			<div className="flex items-center gap-3 border-b border-border px-4 py-3">
				<Link
					to={`/session/${sessionId}`}
					className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<ArrowLeft className="h-5 w-5" />
				</Link>
				<div>
					<h1 className="text-sm font-semibold">{session?.name || "Chat"}</h1>
					{session?.module && (
						<p className="text-xs text-muted-foreground">{session.module}</p>
					)}
				</div>
			</div>

			<div className="flex-1 overflow-hidden">
				<ChatThread sessionId={sessionId} />
			</div>
		</div>
	);
}
