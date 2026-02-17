import { fetchMessages } from "@/lib/api";
import {
	AttachmentPrimitive,
	useAttachmentRuntime,
	useComposerRuntime,
	useThreadRuntime,
} from "@assistant-ui/react";
import { Download, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// ─── Draft Persistence ───

interface DraftData {
	text: string;
	attachments: Array<{ id: string; name: string; contentType: string }>;
}

function getDraftKey(conversationId: string) {
	return `chat-draft::${conversationId}`;
}

export function DraftPersistence({ conversationId }: { conversationId: string }) {
	const composerRuntime = useComposerRuntime();
	const draftKey = getDraftKey(conversationId);
	const restoredRef = useRef(false);

	useEffect(() => {
		if (restoredRef.current) return;
		restoredRef.current = true;
		const raw = sessionStorage.getItem(draftKey);
		if (!raw) return;
		try {
			const draft: DraftData = JSON.parse(raw);
			if (draft.text) {
				composerRuntime.setText(draft.text);
			}
			for (const att of draft.attachments) {
				const restoreName = `__restore__${att.id}__${att.name}`;
				const fakeFile = new File([], restoreName, { type: att.contentType });
				composerRuntime.addAttachment(fakeFile).catch(() => {});
			}
		} catch {
			// Invalid draft data, ignore
		}
	}, [draftKey, composerRuntime]);

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

export function ComposerImageAttachment() {
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const attachmentRuntime = useAttachmentRuntime();
	const state = attachmentRuntime.getState();

	useEffect(() => {
		const file = (state as { file?: File }).file;
		if (file && file.size > 0) {
			const url = URL.createObjectURL(file);
			setPreviewUrl(url);
			return () => URL.revokeObjectURL(url);
		}
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

export function StopButton() {
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

export function ExportButton({
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
