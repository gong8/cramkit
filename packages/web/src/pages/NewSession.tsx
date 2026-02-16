import { createSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

const log = createLogger("web");

export function NewSession() {
	const navigate = useNavigate();
	const [name, setName] = useState("");
	const [module, setModule] = useState("");
	const [examDate, setExamDate] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setSubmitting(true);
		log.info(`handleSubmit — creating session "${name.trim()}"`);
		try {
			const session = await createSession({
				name: name.trim(),
				module: module.trim() || undefined,
				examDate: examDate || undefined,
			});
			log.info(`handleSubmit — created ${session.id}, navigating`);
			navigate(`/session/${session.id}`);
		} catch (err) {
			log.error("handleSubmit — creation failed", err);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="mx-auto max-w-lg">
			<h1 className="mb-6 text-2xl font-bold">New Session</h1>

			<form onSubmit={handleSubmit} className="space-y-4">
				<div>
					<label htmlFor="name" className="mb-1 block text-sm font-medium">
						Session Name *
					</label>
					<input
						id="name"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. PDEs Midterm"
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						required
					/>
				</div>

				<div>
					<label htmlFor="module" className="mb-1 block text-sm font-medium">
						Module
					</label>
					<input
						id="module"
						type="text"
						value={module}
						onChange={(e) => setModule(e.target.value)}
						placeholder="e.g. M2AA1 - Partial Differential Equations"
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
					/>
				</div>

				<div>
					<label htmlFor="examDate" className="mb-1 block text-sm font-medium">
						Exam Date
					</label>
					<input
						id="examDate"
						type="date"
						value={examDate}
						onChange={(e) => setExamDate(e.target.value)}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
					/>
				</div>

				<button
					type="submit"
					disabled={submitting || !name.trim()}
					className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
				>
					{submitting ? "Creating..." : "Create Session"}
				</button>
			</form>
		</div>
	);
}
