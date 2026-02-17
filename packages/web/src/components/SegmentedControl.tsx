interface SegmentedControlProps<T extends string> {
	tabs: readonly T[];
	active: T;
	onChange: (tab: T) => void;
}

export function SegmentedControl<T extends string>({
	tabs,
	active,
	onChange,
}: SegmentedControlProps<T>) {
	return (
		<div className="mb-6 flex justify-center">
			<div className="inline-flex rounded-lg border border-border bg-muted/50 p-1">
				{tabs.map((tab) => (
					<button
						key={tab}
						type="button"
						onClick={() => onChange(tab)}
						className={`rounded-md px-5 py-1.5 text-sm font-medium capitalize transition-colors ${
							active === tab
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						{tab}
					</button>
				))}
			</div>
		</div>
	);
}
