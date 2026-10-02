import { createHash } from "node:crypto";
import { Api, Store } from "@factory/core";
import { Effect } from "effect";
import { changedFilesScript, extractBlobsScript, MEDIA_DIR, withHome } from "./plan.js";
import type { SandboxHandle } from "./sandbox.js";

/**
 * Previews for the run page: images, videos and PDFs the agent changed (by
 * the blob ids in the diff) or that a tool showed it (screenshots, images it
 * read). The bytes are copied into Postgres, so they still show after the
 * sandbox stops, and the harness serves them to the run's owner only.
 */

/** A previewable file and its bytes, keyed like git keys it. */
export interface MediaBlob {
  readonly sha: string;
  readonly mediaType: Api.MediaType;
  readonly bytes: Uint8Array;
}

const NO_BLOB = /^0{40}$/;

/** What `git hash-object` would print for these bytes. */
export const gitBlobSha = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

/**
 * The previewable blobs in `git diff --raw -z --no-abbrev` output, on both
 * sides of each change, so the page can show before and after.
 */
export function changedMedia(raw: string): ReadonlyArray<Omit<MediaBlob, "bytes">> {
  const fields = raw.split("\0");
  const found = new Map<string, Api.MediaType>();
  const add = (sha: string | undefined, path: string | undefined) => {
    const mediaType = path === undefined ? undefined : Api.mediaTypeForPath(path);
    if (sha && /^[0-9a-f]{40}$/.test(sha) && !NO_BLOB.test(sha) && mediaType && !found.has(sha)) found.set(sha, mediaType);
  };
  for (let i = 0; i < fields.length; i++) {
    const header = /^:\d{6} \d{6} ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/.exec(fields[i]!.trim());
    if (!header) continue;
    const [, oldSha, newSha, status] = header;
    const twoPaths = status === "R" || status === "C";
    const oldPath = fields[i + 1];
    const newPath = twoPaths ? fields[i + 2] : oldPath;
    add(oldSha, oldPath);
    add(newSha, newPath);
    i += twoPaths ? 2 : 1;
  }
  return [...found].map(([sha, mediaType]) => ({ sha, mediaType }));
}

/** Most bytes copied out of the sandbox per diff snapshot; the rest wait for the next one. */
const MAX_PASS_BYTES = 64 * 1024 * 1024;

/**
 * Keeps a run's previews in step with its sandbox. One per turn: it loads
 * what the run already has the first time it needs to, and never stores more
 * than `MAX_RUN_MEDIA_BYTES` for a run.
 */
export const makeMediaCapture = (runId: string, sandbox: SandboxHandle) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Effect.makeSemaphore(1);
    let known: Map<string, number> | undefined;
    /** Too large, unreadable, or over the run's budget: not tried again this turn. */
    const skipped = new Set<string>();
    /** Blobs from the last diff that are still to be copied. */
    let pending: ReadonlyArray<Omit<MediaBlob, "bytes">> = [];

    const stored = Effect.gen(function* () {
      if (!known) known = new Map((yield* store.listMedia(runId)).map((m) => [m.sha, m.size]));
      return known;
    });
    const total = (stored: Map<string, number>) => [...stored.values()].reduce((sum, size) => sum + size, 0);
    const fits = (stored: Map<string, number>, size: number) =>
      size > 0 && size <= Api.MAX_MEDIA_BYTES && total(stored) + size <= Api.MAX_RUN_MEDIA_BYTES;

    const save = (blob: MediaBlob) =>
      Effect.gen(function* () {
        const media = yield* stored;
        if (media.has(blob.sha) || skipped.has(blob.sha)) return;
        if (!fits(media, blob.bytes.byteLength)) return void skipped.add(blob.sha);
        yield* store.saveMedia(runId, { sha: blob.sha, media_type: blob.mediaType, data: blob.bytes });
        media.set(blob.sha, blob.bytes.byteLength);
      });

    /** Copies the media files in the run's diff, as of the last diff snapshot. */
    const copyChanged = (diffChanged: boolean) =>
      Effect.gen(function* () {
        if (diffChanged) {
          const listed = yield* sandbox.exec(withHome(changedFilesScript()), { timeoutSec: 60 });
          if (listed.exitCode !== 0) return;
          pending = changedMedia(listed.stdout);
        }
        if (pending.length === 0) return;
        const media = yield* stored;
        const wanted = pending.filter((blob) => !media.has(blob.sha) && !skipped.has(blob.sha));
        if (wanted.length === 0) return;
        const types = new Map(wanted.map((blob) => [blob.sha, blob.mediaType]));
        const extracted = yield* sandbox.exec(withHome(extractBlobsScript([...types.keys()], Api.MAX_MEDIA_BYTES)), { timeoutSec: 120 });
        if (extracted.exitCode !== 0) return;
        let copied = 0;
        for (const line of extracted.stdout.split("\n")) {
          const [sha = "", sizeText = ""] = line.trim().split(" ");
          const mediaType = types.get(sha);
          const size = Number(sizeText);
          if (!mediaType || !Number.isSafeInteger(size)) continue;
          if (!fits(media, size)) {
            skipped.add(sha);
            continue;
          }
          if (copied + size > MAX_PASS_BYTES) break;
          const bytes = yield* sandbox.readFile(`${MEDIA_DIR}/${sha}`, size).pipe(
            Effect.catchAll((error) => Effect.as(Effect.logWarning(error.message), undefined)),
          );
          // A file that changed mid-copy no longer matches its id; leave it out.
          if (!bytes || gitBlobSha(bytes) !== sha) {
            skipped.add(sha);
            continue;
          }
          copied += size;
          yield* save({ sha, mediaType, bytes });
        }
        yield* sandbox.exec(`rm -rf ${MEDIA_DIR}`, { timeoutSec: 30 }).pipe(Effect.ignore);
      });

    return {
      copyChanged: (diffChanged: boolean) => lock.withPermits(1)(copyChanged(diffChanged)),
      save: (blobs: ReadonlyArray<MediaBlob>) => lock.withPermits(1)(Effect.forEach(blobs, save, { discard: true })),
    };
  });

export type MediaCapture = Effect.Effect.Success<ReturnType<typeof makeMediaCapture>>;
