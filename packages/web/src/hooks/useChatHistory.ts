import type { ToolCallData } from "@/lib/api";
import { fetchMessages } from "@/lib/api";
import type { ThreadHistoryAdapter } from "@assistant-ui/react";
import type { QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

export function useChatHistory(
	conversationId: string,
	sessionId: string,
	queryClient: QueryClient,
) {
	return useMemo(
		() =>
			({
				async load() {
					const messages = await fetchMessages(conversationId);

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

						if (m.attachments && m.attachments.length > 0) {
							for (const att of m.attachments) {
								contentParts.push({
									type: "image",
									image: `/api/chat/attachments/${att.id}`,
								});
							}
						}

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

						const callRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
						const resultRe = /<tool_result>\s*([\s\S]*?)\s*<\/tool_result>/g;
						const xmlCalls: Array<{
							name: string;
							args: Record<string, unknown>;
						}> = [];
						const xmlResults: string[] = [];
						let rm: RegExpExecArray | null;
						rm = callRe.exec(m.content);
						while (rm !== null) {
							try {
								const parsed = JSON.parse(rm[1]);
								xmlCalls.push({
									name: parsed.name,
									args: parsed.arguments || {},
								});
							} catch {
								/* skip */
							}
							rm = callRe.exec(m.content);
						}
						rm = resultRe.exec(m.content);
						while (rm !== null) {
							xmlResults.push(rm[1].trim());
							rm = resultRe.exec(m.content);
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
								status: {
									type: "complete",
									reason: "stop",
								} as const,
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
					queryClient.invalidateQueries({
						queryKey: ["conversations", sessionId],
					});
				},
			}) as unknown as ThreadHistoryAdapter,
		[conversationId, sessionId, queryClient],
	);
}
