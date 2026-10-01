import { MAX_IMAGE_BYTES, MAX_IMAGES } from "@factory/core/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventImages, imageFileError, readImage } from "../src/lib/composer-images.js";
import { toBlocks } from "../src/lib/activity.js";

const file = { name: "screenshot.png", type: "image/png", size: 123 };
const image = { id: "0b879081-7d21-4692-b739-895704b0c293", name: file.name, mediaType: file.type };
afterEach(() => vi.unstubAllGlobals());

describe("composer images", () => {
  it("accepts supported images within the file size and count limits", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(imageFileError({ ...file, type, size: MAX_IMAGE_BYTES }, MAX_IMAGES - 1)).toBeUndefined();
    }
  });

  it("explains unsupported, empty, oversized, and excess files", () => {
    expect(imageFileError({ ...file, type: "image/svg+xml" }, 0)).toContain("PNG");
    expect(imageFileError({ ...file, type: "text/plain" }, 0)).toContain("PNG");
    expect(imageFileError({ ...file, size: 0 }, 0)).toContain("empty");
    expect(imageFileError({ ...file, size: MAX_IMAGE_BYTES + 1 }, 0)).toContain("too large");
    expect(imageFileError(file, MAX_IMAGES)).toContain("up to 4");
  });

  it("reads files as base64 uploads without including the data URL prefix", async () => {
    vi.stubGlobal("FileReader", class {
      result = "data:image/png;base64,aGVsbG8=";
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    });
    expect(await readImage(new File(["hello"], "design.png", { type: "image/png" }))).toEqual({
      name: "design.png", mediaType: "image/png", data: "aGVsbG8=",
    });
  });

  it("reports file read failures rather than sending an empty upload", async () => {
    vi.stubGlobal("FileReader", class {
      onerror?: () => void;
      readAsDataURL() { this.onerror?.(); }
    });
    await expect(readImage(new File(["hello"], "design.png", { type: "image/png" }))).rejects.toThrow("Could not read “design.png”");
  });

  it("keeps valid attachment metadata in the conversation and ignores malformed event data", () => {
    expect(eventImages(null)).toEqual([]);
    expect(eventImages({ images: "invalid" })).toEqual([]);
    const data = { images: [image, { ...image, id: "../../settings" }, { ...image, mediaType: "text/html" }, null] };
    expect(eventImages(data)).toEqual([image]);
    expect(toBlocks([{ id: "1", kind: "user_message", message: "Use this design", at: new Date(0), data }])).toEqual([
      { type: "user", id: "1", text: "Use this design", at: new Date(0), images: [image] },
    ]);
  });
});
