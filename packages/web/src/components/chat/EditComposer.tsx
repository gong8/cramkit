import { ComposerPrimitive, MessagePrimitive } from "@assistant-ui/react";
import { useEffect, useRef } from "react";

export function EditComposer() {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		ref.current?.scrollIntoView({ block: "center", behavior: "instant" });
	}, []);

	return (
		<MessagePrimitive.Root className="flex justify-end px-4 py-2">
			<div ref={ref} className="w-full max-w-[80%]">
				<ComposerPrimitive.Root className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-background p-3">
					<ComposerPrimitive.Input className="flex-1 resize-none bg-transparent text-sm outline-none max-h-[200px] overflow-y-auto" />
					<div className="flex items-center gap-2 justify-end">
						<ComposerPrimitive.Cancel className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
							Cancel
						</ComposerPrimitive.Cancel>
						<ComposerPrimitive.Send className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
							Save & Regenerate
						</ComposerPrimitive.Send>
					</div>
				</ComposerPrimitive.Root>
			</div>
		</MessagePrimitive.Root>
	);
}
