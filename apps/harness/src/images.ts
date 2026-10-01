import { Api } from "@factory/core";

const matchesFormat = (bytes: Buffer, mediaType: Api.ImageMediaType): boolean => {
  switch (mediaType) {
    case "image/png": return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif": return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
    case "image/webp": return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
};

/** Validate bytes as well as the JSON shape before storing untrusted uploads. */
export const validateImages = (images: ReadonlyArray<Api.ImageUpload>): string | undefined => {
  if (images.length > Api.MAX_IMAGES) return `Attach up to ${Api.MAX_IMAGES} images per message.`;
  for (const image of images) {
    if (!image.name.trim() || image.name.length > 255) return "Give each image a name of up to 255 characters.";
    if (image.data.length > 4 * Math.ceil(Api.MAX_IMAGE_BYTES / 3)) return "Keep each image to 5 MB or less.";
    const bytes = Buffer.from(image.data, "base64");
    if (!bytes.length || bytes.toString("base64") !== image.data) return "That image could not be read. Try attaching it again.";
    if (bytes.length > Api.MAX_IMAGE_BYTES) return "Keep each image to 5 MB or less.";
    if (!matchesFormat(bytes, image.mediaType)) return "Attach a PNG, JPEG, WebP, or GIF image with the matching file type.";
  }
};
