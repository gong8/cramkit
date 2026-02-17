/**
 * Buffers incoming text chunks and yields complete newline-delimited lines.
 * Shared by cli-chat (stdout parsing) and stream-manager (SSE parsing).
 */
export class LineBuffer {
	private buffer = "";

	/** Append a chunk and return all complete lines (excluding the trailing partial). */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const parts = this.buffer.split("\n");
		this.buffer = parts.pop() || "";
		return parts;
	}
}
