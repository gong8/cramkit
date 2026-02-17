import type { CodeHeaderProps } from "@assistant-ui/react-markdown";
import { Check, ClipboardCopy } from "lucide-react";
import { useState } from "react";

export function CodeHeader({ code }: CodeHeaderProps) {
	const [copied, setCopied] = useState(false);

	const handleCopy = () => {
		navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	};

	return (
		<div className="flex items-center justify-end -mb-2 px-1">
			<button
				type="button"
				onClick={handleCopy}
				className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
				title="Copy code"
			>
				{copied ? (
					<Check className="h-3.5 w-3.5 text-green-600" />
				) : (
					<ClipboardCopy className="h-3.5 w-3.5" />
				)}
			</button>
		</div>
	);
}
