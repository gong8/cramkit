import { ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { Paperclip, Send } from "lucide-react";
import { ComposerImageAttachment, StopButton } from "./ComposerComponents.js";

export function ChatComposer() {
	return (
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
	);
}
