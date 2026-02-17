import {
	ActionBarPrimitive,
	MessagePrimitive,
	useAttachmentRuntime,
	useMessage,
	useMessagePartImage,
	useMessageRuntime,
} from "@assistant-ui/react";
import { ClipboardCopy, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

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
