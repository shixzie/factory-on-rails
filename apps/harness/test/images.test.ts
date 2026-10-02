import { describe, expect, it } from "vitest";
import { Api } from "@factory/core";
import { Schema } from "effect";
import { validateImages } from "../src/images.js";

const png: Api.ImageUpload = {
  name: "screenshot.png",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC2kAAAAASUVORK5CYII=",
};

describe("image uploads", () => {
  it("accepts supported image formats and image-free messages", () => {
    expect(validateImages([])).toBeUndefined();
    const images: Api.ImageUpload[] = [
      png,
      { name: "image.jpg", mediaType: "image/jpeg", data: Buffer.from([255, 216, 255, 224]).toString("base64") },
      { name: "image.gif", mediaType: "image/gif", data: Buffer.from("GIF89a").toString("base64") },
      { name: "image.webp", mediaType: "image/webp", data: Buffer.from("RIFF0000WEBP").toString("base64") },
    ];
    expect(validateImages(images)).toBeUndefined();
    expect(Schema.decodeUnknownSync(Api.SendMessageBody)({ text: "", images })).toEqual({ text: "", images });
  });

  it("rejects malformed base64 and a MIME type that does not match the image", () => {
    for (const data of ["", "not base64!", png.data + "\n", `data:image/png;base64,${png.data}`]) {
      expect(validateImages([{ ...png, data }])).toBeDefined();
    }
    expect(validateImages([{ ...png, mediaType: "image/jpeg" }])).toMatch(/matching file type/);
    expect(validateImages([{ ...png, data: Buffer.from("<svg></svg>").toString("base64") }])).toMatch(/PNG/);
    expect(() => Schema.decodeUnknownSync(Api.ImageUpload)({ ...png, mediaType: "image/svg+xml" })).toThrow();
  });

  it("enforces per-message image count and the exact decoded-byte limit", () => {
    expect(validateImages(Array.from({ length: Api.MAX_IMAGES + 1 }, () => png))).toMatch(/up to 4/);
    expect(() => Schema.decodeUnknownSync(Api.SendMessageBody)({ text: "x", images: Array.from({ length: Api.MAX_IMAGES + 1 }, () => png) })).toThrow();
    const bytes = Buffer.alloc(Api.MAX_IMAGE_BYTES + 1);
    Buffer.from(png.data, "base64").copy(bytes);
    expect(validateImages([{ ...png, data: bytes.subarray(0, Api.MAX_IMAGE_BYTES).toString("base64") }])).toBeUndefined();
    expect(validateImages([{ ...png, data: bytes.toString("base64") }])).toMatch(/5 MB/);
  });
});
