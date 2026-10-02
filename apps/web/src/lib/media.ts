/** Where the run page loads a preview from: the harness, by the file's git blob id, for the run's owner only. */
export const mediaUrl = (runId: string, sha: string) => `/api/runs/${encodeURIComponent(runId)}/media/${encodeURIComponent(sha)}`;

/** Waits between checks for a preview that isn't stored yet (the runner copies files out a moment after the diff shows them). */
export const probeDelays = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
