import { FileList } from "@/components/FileList";
import { FileUpload } from "@/components/FileUpload";
import { fetchSession, fetchSessionFiles } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";

export function SessionDetail() {
	const { id } = useParams<{ id: string }>();

	const sessionId = id as string;

	const { data: session, isLoading } = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => fetchSession(sessionId),
		enabled: !!sessionId,
	});

	const { data: files } = useQuery({
		queryKey: ["session-files", sessionId],
		queryFn: () => fetchSessionFiles(sessionId),
		enabled: !!sessionId,
	});

	if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
	if (!session) return <p className="text-muted-foreground">Session not found.</p>;

	return (
		<div>
			<div className="mb-6">
				<h1 className="text-2xl font-bold">{session.name}</h1>
				{session.module && <p className="mt-1 text-muted-foreground">{session.module}</p>}
				{session.examDate && (
					<p className="mt-1 text-sm text-muted-foreground">
						Exam: {new Date(session.examDate).toLocaleDateString()}
					</p>
				)}
			</div>

			{session.scope && (
				<div className="mb-6 rounded-lg border border-border p-4">
					<h2 className="mb-2 text-sm font-semibold uppercase text-muted-foreground">Exam Scope</h2>
					<p className="text-sm whitespace-pre-wrap">{session.scope}</p>
				</div>
			)}

			<div className="mb-6">
				<h2 className="mb-3 text-lg font-semibold">Files</h2>
				<FileUpload sessionId={sessionId} />
				<FileList files={files || []} />
			</div>
		</div>
	);
}
