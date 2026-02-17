import { createSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

const log = createLogger("web");

const inputClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function Field({
	id,
	label,
	...props
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-sm font-medium">
				{label}
			</label>
			<input id={id} className={inputClass} {...props} />
		</div>
	);
}

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
				<Field
					id="name"
					label="Session Name *"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="e.g. PDEs Midterm"
					required
				/>
				<Field
					id="module"
					label="Module"
					type="text"
					value={module}
					onChange={(e) => setModule(e.target.value)}
					placeholder="e.g. M2AA1 - Partial Differential Equations"
				/>
				<Field
					id="examDate"
					label="Exam Date"
					type="date"
					value={examDate}
					onChange={(e) => setExamDate(e.target.value)}
				/>

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
