import { ActionBarPrimitive, MessagePrimitive, useMessage } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ClipboardCopy, RefreshCw } from "lucide-react";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeHeader } from "./CodeHeader.js";
import { ReasoningDisplay } from "./ReasoningDisplay.js";
import { ToolCallDisplay } from "./ToolCallDisplay.js";

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
