import { ComposerPrimitive } from "@assistant-ui/react";

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
