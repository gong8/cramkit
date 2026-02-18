export class CancellationError extends Error {
	constructor(message = "Operation cancelled") {
		super(message);
		this.name = "CancellationError";
	}
}
