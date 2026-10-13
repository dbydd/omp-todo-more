/** The message of a thrown value, for logs and user-facing reasons. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
