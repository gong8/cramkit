import { fetchSessions } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

const log = createLogger("web");

export function Dashboard() {
	const { data: sessions, isLoading } = useQuery({
		queryKey: ["sessions"],
		queryFn: () => {
			log.info("Dashboard — fetching sessions");
			return fetchSessions();
		},
	});

	return (
		<div>
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-2xl font-bold">Sessions</h1>
				<Link
					to="/new"
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
				>
					New Session
				</Link>
			</div>

			{isLoading && <p className="text-muted-foreground">Loading...</p>}

			{sessions && sessions.length === 0 && (
				<div className="rounded-lg border border-border p-8 text-center">
					<p className="text-muted-foreground">No sessions yet. Create one to get started.</p>
				</div>
			)}

			<div className="grid gap-4 sm:grid-cols-2">
				{sessions?.map((session) => (
					<Link
						key={session.id}
						to={`/session/${session.id}`}
						className="rounded-lg border border-border p-4 transition-colors hover:bg-accent"
					>
						<h2 className="font-semibold">{session.name}</h2>
						{session.module && (
							<p className="mt-1 text-sm text-muted-foreground">{session.module}</p>
						)}
						<div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
							<span>{session.resourceCount} resource{session.resourceCount !== 1 ? "s" : ""}</span>
							{session.examDate && (
								<span>Exam: {new Date(session.examDate).toLocaleDateString()}</span>
							)}
						</div>
					</Link>
				))}
			</div>
		</div>
	);
}
