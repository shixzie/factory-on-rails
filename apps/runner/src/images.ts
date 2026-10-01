import { Api, type ImageRow, type RunEventRow } from "@factory/core";
import { Effect, Schema } from "effect";
import { FACTORY_DIR } from "./plan.js";
import { SandboxError, type SandboxHandle } from "./sandbox.js";

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Stable paths survive session recovery and never depend on a user filename. */
export function imagePath(image: Pick<Api.ImageAttachment, "id" | "mediaType">): string {
  const extension = extensions[image.mediaType];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(image.id) || !extension) throw new Error("Invalid image attachment metadata");
  return `${FACTORY_DIR}/images/${image.id}.${extension}`;
}

export const messageImages = (message: Pick<RunEventRow, "data">): ReadonlyArray<Api.ImageAttachment> =>
  Schema.decodeUnknownSync(Schema.Array(Api.ImageAttachment))(message.data?.images ?? []);

/** Both agents can inspect local images with their existing file tools. */
export function withImages(text: string, images: ReadonlyArray<Api.ImageAttachment> = []): string {
  if (images.length === 0) return text;
  return [
    text.trim(),
    "Attached images (open these files with your image viewing tools before responding):",
    ...images.map((image) => `- ${imagePath(image)} (${JSON.stringify(image.name)})`),
  ].filter(Boolean).join("\n\n");
}

/** Railway streams bytes directly, without putting image data in commands or logs. */
export const materializeImage = (sandbox: SandboxHandle, image: ImageRow) =>
  Effect.gen(function* () {
    const path = yield* Effect.try({
      try: () => imagePath({ id: image.id, mediaType: image.media_type }),
      catch: () => new SandboxError({ message: "Invalid image attachment metadata" }),
    });
    yield* sandbox.writeFile(path, Buffer.from(image.data, "base64"), 0o600);
  });
