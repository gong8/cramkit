import { AlertTriangle, Check, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Options as RehypeKatexOptions } from "rehype-katex";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { remarkMathDisplay } from "../../lib/remark-math-display.js";
import { ReasoningDisplay, getToolLabel } from "./MessageComponents.js";

const katexOptions: RehypeKatexOptions = {
	trust: true,
	strict: false,
	errorColor: "#888888",
};

// ─── Types ───

export interface ReconnectStream {
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

// ─── Reconnect Stream View ───

export function ReconnectStreamView({ stream }: { stream: ReconnectStream }) {
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
				<div className="prose prose-sm max-w-none rounded-2xl bg-muted px-4 py-2">
					{stream.thinkingText && <ReasoningDisplay type="reasoning" text={stream.thinkingText} />}
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
							remarkPlugins={[remarkGfm, remarkMath, remarkMathDisplay]}
							rehypePlugins={[[rehypeKatex, katexOptions]]}
						>
							{cleanContent}
						</ReactMarkdown>
					)}
				</div>
			</div>
		</div>
	);
}
