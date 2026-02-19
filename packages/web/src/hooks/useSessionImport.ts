import { importSession } from "@/lib/api";
import { createLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

const log = createLogger("web");

export function useSessionImport() {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isImporting, setIsImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);

	const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		setIsImporting(true);
		setImportError(null);
		log.info(`handleImport — file: ${file.name}`);
		try {
			const result = await importSession(file);
			queryClient.invalidateQueries({ queryKey: ["sessions"] });
			navigate(`/session/${result.sessionId}`);
		} catch (err) {
			log.error("handleImport — failed", err);
			setImportError(err instanceof Error ? err.message : "Import failed");
		} finally {
			setIsImporting(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	const dismissError = () => setImportError(null);
	const triggerFileInput = () => fileInputRef.current?.click();

	return { fileInputRef, isImporting, importError, handleImport, dismissError, triggerFileInput };
}
