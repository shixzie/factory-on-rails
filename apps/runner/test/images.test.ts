import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { imagePath, materializeImage, messageImages, withImages } from "../src/images.js";
import { Sandboxes } from "../src/sandbox.js";
import { fakeSandboxes } from "./stubs.js";

const image = { id: "0123abcd-0000-4000-8000-000000000000", name: 'Screenshot $(touch hacked) "test".png', mediaType: "image/png" as const };

describe("image attachments", () => {
  it.effect("writes the original bytes to a stable path outside the repository", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({}, { alive: ["sbx"] });
      const service = yield* Effect.provide(Sandboxes, sandboxes.layer);
      const sandbox = Option.getOrThrow(yield* service.connect("sbx"));
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
      yield* materializeImage(sandbox, { id: image.id, run_id: "run", name: image.name, media_type: image.mediaType, data: bytes.toString("base64") });
      expect(sandboxes.state.binaryFiles[imagePath(image)]).toEqual(bytes);
      expect(sandboxes.state.modes[imagePath(image)]).toBe(0o600);
      expect(sandboxes.state.commands).toEqual([]);
    }),
  );

  it("rejects path traversal and unsupported image types", () => {
    expect(() => imagePath({ ...image, id: "../../repo/README" })).toThrow("Invalid image attachment metadata");
    expect(() => imagePath({ id: image.id, mediaType: "text/html" as typeof image.mediaType })).toThrow("Invalid image attachment metadata");
  });

  it("adds image paths to text and image-only messages", () => {
    expect(withImages("Use this design", [image])).toContain("Use this design\n\nAttached images");
    expect(withImages("", [image])).toContain(imagePath(image));
    expect(withImages("Keep this text\n", [])).toBe("Keep this text\n");
    expect(messageImages({ data: { images: [image] } })).toEqual([image]);
    expect(messageImages({ data: null })).toEqual([]);
  });
});
