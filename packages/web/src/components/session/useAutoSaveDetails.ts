import { type Session, updateSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

const log = createLogger("web");

export function useAutoSaveDetails(sessionId: string, session: Session | undefined) {
	const queryClient = useQueryClient();

	const [scope, setScope] = useState("");
	const [notes, setNotes] = useState("");
	const [examDate, setExamDate] = useState("");
	const initialized = useRef(false);
	const savedValues = useRef({ scope: "", notes: "", examDate: "" });

	useEffect(() => {
		if (session && !initialized.current) {
			const s = session.scope ?? "";
			const n = session.notes ?? "";
			const d = session.examDate ? new Date(session.examDate).toISOString().split("T")[0] : "";
			setScope(s);
			setNotes(n);
			setExamDate(d);
			savedValues.current = { scope: s, notes: n, examDate: d };
			initialized.current = true;
		}
	}, [session]);

	useEffect(() => {
		if (!initialized.current) return;
		const patch: Record<string, string | null> = {};
		if (scope !== savedValues.current.scope) patch.scope = scope || null;
		if (notes !== savedValues.current.notes) patch.notes = notes || null;
		if (examDate !== savedValues.current.examDate) patch.examDate = examDate || null;
		if (Object.keys(patch).length === 0) return;

		const timer = setTimeout(() => {
			updateSession(sessionId, patch)
				.then((updated) => {
					savedValues.current = { scope, notes, examDate };
					queryClient.setQueryData(["session", sessionId], (old: Session | undefined) =>
						old ? { ...old, ...updated } : old,
					);
				})
				.catch((err) => {
					log.error("Auto-save failed", err);
				});
		}, 800);
		return () => clearTimeout(timer);
	}, [scope, notes, examDate, sessionId, queryClient]);

	return { scope, setScope, notes, setNotes, examDate, setExamDate };
}
