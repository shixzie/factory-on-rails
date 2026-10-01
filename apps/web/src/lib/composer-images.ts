import { ImageAttachment, MAX_IMAGE_BYTES, MAX_IMAGES, type ImageUpload } from "@factory/core/api";
import { Schema } from "effect";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export function imageFileError(file: Pick<File, "type" | "size" | "name">, count: number): string | undefined {
  if (!IMAGE_ACCEPT.split(",").includes(file.type)) return "Choose a PNG, JPEG, WebP, or GIF image.";
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_IMAGE_BYTES) return `“${file.name}” is too large. Images can be up to 5 MB.`;
  if (count >= MAX_IMAGES) return `You can attach up to ${MAX_IMAGES} images per message.`;
  return undefined;
}

export function readImage(file: File): Promise<ImageUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read “${file.name}”. Try attaching it again.`));
    reader.onabort = reader.onerror;
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({
        name: (file.name || "image").slice(0, 255),
        mediaType: file.type as ImageUpload["mediaType"],
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Event data is untyped; only render image metadata that matches the API contract. */
export function eventImages(data: Record<string, unknown> | null | undefined): readonly ImageAttachment[] {
  return Array.isArray(data?.images) ? data.images.filter(Schema.is(ImageAttachment)) : [];
}
