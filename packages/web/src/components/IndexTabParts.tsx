import type { BatchResource, IndexStatus, PhaseInfo } from "@/lib/api";
import {
	AlertTriangle,
	ArrowRight,
	Check,
	Circle,
	Layers,
	Link2,
	Loader2,
	X,
	Zap,
} from "lucide-react";

const QUEUE_TYPE_LABELS: Record<string, string> = {
	LECTURE_NOTES: "Notes",
	PAST_PAPER: "Paper",
	PROBLEM_SHEET: "Sheet",
	SPECIFICATION: "Spec",
	OTHER: "Other",
};

const QUEUE_TYPE_COLORS: Record<string, string> = {
	LECTURE_NOTES: "bg-blue-100 text-blue-700",
	PAST_PAPER: "bg-amber-100 text-amber-700",
	PROBLEM_SHEET: "bg-purple-100 text-purple-700",
	SPECIFICATION: "bg-gray-100 text-gray-700",
	OTHER: "bg-gray-100 text-gray-700",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
	completed: <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />,
	indexing: <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />,
	pending: <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />,
	cancelled: <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />,
	failed: <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />,
};

const ERROR_TYPE_LABELS: Record<string, string> = {
	llm_error: "LLM Error",
	parse_error: "Parse Error",
	db_error: "Database Error",
	unknown: "Unknown Error",
};

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = Math.ceil(seconds % 60);
	return `${mins}m ${secs}s`;
}

function formatEta(seconds: number): string {
	if (seconds < 60) return `~${Math.ceil(seconds)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = Math.ceil(seconds % 60);
	return `~${mins}m ${secs}s`;
}

function computePhaseEta(
	completed: number,
	total: number,
	startedAt: number,
	avgDurationMs: number | null,
): string | null {
	const remaining = total - completed;
	if (remaining <= 0) return null;

	if (avgDurationMs && completed > 0) {
		return formatEta((remaining * avgDurationMs) / 1000);
	}

	if (completed > 0) {
		const elapsed = Date.now() - startedAt;
		const msPerResource = elapsed / completed;
		return formatEta((remaining * msPerResource) / 1000);
	}

	return null;
}

function PhaseIndicator({ phase }: { phase: PhaseInfo }) {
	const steps = [
		{
			num: 1,
			label: "Foundation",
			desc: phase.phase1.total > 0
				? `${phase.phase1.total} lecture${phase.phase1.total !== 1 ? "s" : ""}/spec${phase.phase1.total !== 1 ? "s" : ""} (sequential)`
				: "No lectures/specs",
			icon: <Layers className="h-3.5 w-3.5" />,
			done: phase.phase1.completed + phase.phase1.failed >= phase.phase1.total,
			active: phase.current === 1,
			total: phase.phase1.total,
		},
		{
			num: 2,
			label: "Linking",
			desc: phase.phase2.total > 0
				? `${phase.phase2.total} paper${phase.phase2.total !== 1 ? "s" : ""}/sheet${phase.phase2.total !== 1 ? "s" : ""} (${phase.phase2.concurrency}x parallel)`
				: "No papers/sheets",
			icon: <Zap className="h-3.5 w-3.5" />,
			done: phase.phase2.total === 0 || phase.phase2.completed + phase.phase2.failed >= phase.phase2.total,
			active: phase.current === 2,
			total: phase.phase2.total,
		},
		{
			num: 3,
			label: "Cross-link",
			desc: "Connect concepts across resources",
			icon: <Link2 className="h-3.5 w-3.5" />,
			done: phase.phase3.status === "completed" || phase.phase3.status === "skipped",
			active: phase.current === 3,
			total: 1,
		},
	];

	return (
		<div className="flex items-center gap-1">
			{steps.map((step, i) => (
				<div key={step.num} className="flex items-center gap-1">
					{i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground/30" />}
					<div
						className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-all ${
							step.active
								? "bg-primary/10 text-primary font-medium ring-1 ring-primary/20"
								: step.done
									? "bg-green-50 text-green-700"
									: "bg-muted/50 text-muted-foreground"
						}`}
						title={step.desc}
					>
						{step.active ? (
							<Loader2 className="h-3 w-3 animate-spin" />
						) : step.done ? (
							<Check className="h-3 w-3" />
						) : (
							step.icon
						)}
						<span>{step.label}</span>
					</div>
				</div>
			))}
		</div>
	);
}

function PhaseDetail({ phase, status }: { phase: PhaseInfo; status: IndexStatus }) {
	const elapsed = Date.now() - (status.batch?.startedAt ?? Date.now());

	return (
		<div className="space-y-1.5 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
			{phase.current === 1 && (
				<>
					<div className="font-medium text-primary">
						Phase 1: Building concept foundation
					</div>
					<div className="text-muted-foreground">
						Processing lectures and specifications sequentially to establish the concept
						graph before linking other materials.
					</div>
					<div className="flex items-center gap-3 text-muted-foreground">
						<span>
							{phase.phase1.completed}/{phase.phase1.total} complete
						</span>
						{phase.phase1.failed > 0 && (
							<span className="text-destructive">
								{phase.phase1.failed} failed
							</span>
						)}
						{(() => {
							const eta = computePhaseEta(
								phase.phase1.completed,
								phase.phase1.total,
								status.batch?.startedAt ?? Date.now(),
								status.avgDurationMs,
							);
							return eta ? <span>{eta} remaining</span> : null;
						})()}
					</div>
				</>
			)}

			{phase.current === 2 && (
				<>
					<div className="font-medium text-primary">
						Phase 2: Linking papers and sheets
					</div>
					<div className="text-muted-foreground">
						Processing {phase.phase2.total} resource{phase.phase2.total !== 1 ? "s" : ""}{" "}
						in parallel ({phase.phase2.concurrency} concurrent) — linking to concepts
						established in Phase 1.
					</div>
					<div className="flex items-center gap-3 text-muted-foreground">
						<span>
							{phase.phase2.completed}/{phase.phase2.total} complete
						</span>
						{phase.phase2.running > 0 && (
							<span className="text-primary">
								{phase.phase2.running} running
							</span>
						)}
						{phase.phase2.failed > 0 && (
							<span className="text-destructive">
								{phase.phase2.failed} failed
							</span>
						)}
						{(() => {
							const eta = computePhaseEta(
								phase.phase2.completed,
								phase.phase2.total,
								status.batch?.startedAt ?? Date.now(),
								status.avgDurationMs,
							);
							return eta ? <span>{eta} remaining</span> : null;
						})()}
					</div>
				</>
			)}

			{phase.current === 3 && (
				<>
					<div className="font-medium text-primary">
						Phase 3: Cross-linking concepts
					</div>
					<div className="text-muted-foreground">
						Analyzing the full knowledge graph to find missing connections between
						concepts from different resources.
					</div>
				</>
			)}

			{phase.current === null && status.batch?.cancelled && (
				<div className="font-medium text-muted-foreground">Indexing cancelled</div>
			)}

			<div className="border-t border-border/50 pt-1.5 text-muted-foreground/70">
				Elapsed: {formatDuration(elapsed)}
				{phase.phase3.status === "completed" &&
					phase.phase3.linksAdded !== undefined &&
					` | Cross-links added: ${phase.phase3.linksAdded}`}
			</div>
		</div>
	);
}

function BatchResourceRow({ resource }: { resource: BatchResource }) {
	return (
		<div
			className={`flex items-center gap-2 px-3 py-1.5 text-sm ${
				resource.status === "cancelled" ? "text-muted-foreground line-through" : ""
			}`}
		>
			{STATUS_ICONS[resource.status]}
			<span className="min-w-0 flex-1 truncate">{resource.name}</span>
			{resource.status === "failed" && resource.errorType && (
				<span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
					{ERROR_TYPE_LABELS[resource.errorType] ?? resource.errorType}
				</span>
			)}
			{resource.attempts > 1 && (
				<span className="shrink-0 text-[10px] text-muted-foreground">
					attempt {resource.attempts}
				</span>
			)}
			<span
				className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
					QUEUE_TYPE_COLORS[resource.type] || QUEUE_TYPE_COLORS.OTHER
				}`}
			>
				{QUEUE_TYPE_LABELS[resource.type] || resource.type}
			</span>
			<span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
				{resource.status === "completed" && resource.durationMs != null
					? formatDuration(resource.durationMs)
					: resource.status === "indexing"
						? "..."
						: ""}
			</span>
		</div>
	);
}

function PhaseResourceGroup({
	phaseNum,
	label,
	mode,
	resources,
}: {
	phaseNum: number;
	label: string;
	mode: string;
	resources: BatchResource[];
}) {
	if (resources.length === 0) return null;

	return (
		<div>
			<div className="flex items-center gap-2 border-b border-border/50 px-3 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
				<span>Phase {phaseNum}</span>
				<span className="text-muted-foreground/50">|</span>
				<span>{label}</span>
				<span className="text-muted-foreground/50">|</span>
				<span>{mode}</span>
			</div>
			{resources.map((r) => (
				<BatchResourceRow key={r.id} resource={r} />
			))}
		</div>
	);
}

interface IndexProgressProps {
	indexStatus: IndexStatus | null;
	batchFailed: number;
}

export function IndexProgressSection({ indexStatus, batchFailed }: IndexProgressProps) {
	const batch = indexStatus?.batch;
	const progressPercent =
		batch && batch.batchTotal > 0
			? Math.round(((batch.batchCompleted + batchFailed) / batch.batchTotal) * 100)
			: 0;

	const phase = batch?.phase;
	const p1Resources = batch?.resources.filter((r) => r.phase === 1) ?? [];
	const p2Resources = batch?.resources.filter((r) => r.phase === 2) ?? [];

	return (
		<div className="space-y-3">
			{/* Phase indicator */}
			{phase && <PhaseIndicator phase={phase} />}

			{/* Progress bar */}
			<div className="space-y-1">
				<div className="h-2 w-full overflow-hidden rounded-full bg-primary/10">
					<div
						className="h-full rounded-full bg-primary transition-all duration-500"
						style={{ width: `${progressPercent}%` }}
					/>
				</div>
				<div className="flex items-center justify-between text-xs text-muted-foreground">
					<span>
						{batch
							? `${batch.batchCompleted}/${batch.batchTotal} resources indexed`
							: "Starting..."}
					</span>
					<span>{progressPercent}%</span>
				</div>
			</div>

			{/* Phase detail */}
			{phase && indexStatus && <PhaseDetail phase={phase} status={indexStatus} />}

			{/* Resource list grouped by phase */}
			{batch?.resources && batch.resources.length > 0 && (
				<div className="overflow-hidden rounded-md border border-border bg-muted/30">
					<PhaseResourceGroup
						phaseNum={1}
						label="Foundation"
						mode="Sequential"
						resources={p1Resources}
					/>
					<PhaseResourceGroup
						phaseNum={2}
						label="Linking"
						mode={`Parallel (${phase?.phase2.concurrency ?? 3}x)`}
						resources={p2Resources}
					/>
				</div>
			)}

			{/* Phase 3 status */}
			{phase?.phase3.status === "completed" && (
				<div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
					<Check className="h-3.5 w-3.5" />
					<span>
						Cross-linking complete
						{phase.phase3.linksAdded !== undefined &&
							` — ${phase.phase3.linksAdded} new connection${phase.phase3.linksAdded !== 1 ? "s" : ""} found`}
					</span>
				</div>
			)}
			{phase?.phase3.status === "failed" && (
				<div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
					<AlertTriangle className="h-3.5 w-3.5" />
					<span>
						Cross-linking failed (non-fatal)
						{phase.phase3.error && `: ${phase.phase3.error}`}
					</span>
				</div>
			)}
		</div>
	);
}

export function BatchFailuresSection({
	resources,
	failedCount,
}: {
	resources: BatchResource[];
	failedCount: number;
}) {
	const failed = resources.filter((r) => r.status === "failed");

	return (
		<div className="space-y-2">
			<p className="text-sm font-medium text-destructive">
				{failedCount} resource{failedCount > 1 ? "s" : ""} failed
			</p>
			<div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2">
				{failed.map((r) => (
					<div key={r.id} className="space-y-0.5 rounded-md px-2 py-1.5">
						<div className="flex items-center gap-2 text-sm">
							<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
							<span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
							<span
								className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
									QUEUE_TYPE_COLORS[r.type] || QUEUE_TYPE_COLORS.OTHER
								}`}
							>
								{QUEUE_TYPE_LABELS[r.type] || r.type}
							</span>
						</div>
						<div className="ml-6 flex flex-wrap items-center gap-2 text-xs">
							{r.errorType && (
								<span className="rounded bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">
									{ERROR_TYPE_LABELS[r.errorType] ?? r.errorType}
								</span>
							)}
							{r.attempts > 1 && (
								<span className="text-muted-foreground">
									{r.attempts} attempts
								</span>
							)}
							{r.durationMs != null && (
								<span className="text-muted-foreground">
									{formatDuration(r.durationMs)}
								</span>
							)}
						</div>
						{r.errorMessage && (
							<p className="ml-6 text-xs text-destructive/80">{r.errorMessage}</p>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
