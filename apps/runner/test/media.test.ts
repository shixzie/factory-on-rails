import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { blockMedia, withMedia } from "../src/agent-stream.js";
import { changedMedia, gitBlobSha } from "../src/media.js";
import { extractBlobsScript } from "../src/plan.js";

const ZERO = "0".repeat(40);
const sha = (c: string) => c.repeat(40);

describe("gitBlobSha", () => {
  it("matches git hash-object", () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    expect(gitBlobSha(bytes)).toBe(execFileSync("git", ["hash-object", "--stdin"], { input: bytes }).toString().trim());
  });
});

describe("changedMedia", () => {
  it("finds previewable files on both sides of a change, renames included", () => {
    const raw = [
      `:000000 100644 ${ZERO} ${sha("a")} A`, "docs/shot.PNG",
      `:100644 100644 ${sha("b")} ${sha("c")} M`, "demo.mp4",
      `:100644 000000 ${sha("d")} ${ZERO} D`, "old.pdf",
      `:100644 100644 ${sha("e")} ${sha("f")} R087`, "img/a.gif", "img/b.webp",
      `:100644 100644 ${sha("1")} ${sha("2")} M`, "src/app.ts",
      `:100644 100644 ${sha("3")} ${sha("4")} M`, "weird name with spaces.jpeg",
      "",
    ].join("\0");
    expect(changedMedia(raw)).toEqual([
      { sha: sha("a"), mediaType: "image/png" },
      { sha: sha("b"), mediaType: "video/mp4" },
      { sha: sha("c"), mediaType: "video/mp4" },
      { sha: sha("d"), mediaType: "application/pdf" },
      { sha: sha("e"), mediaType: "image/gif" },
      { sha: sha("f"), mediaType: "image/webp" },
      { sha: sha("3"), mediaType: "image/jpeg" },
      { sha: sha("4"), mediaType: "image/jpeg" },
    ]);
  });

  it("ignores anything that is not raw diff output", () => {
    expect(changedMedia("diff --git a/x.png b/x.png\nBinary files differ\n")).toEqual([]);
    expect(changedMedia("")).toEqual([]);
  });
});

describe("extractBlobsScript", () => {
  it("only takes blob ids", () => {
    expect(extractBlobsScript([sha("a")], 10)).toContain(`for sha in ${sha("a")}; do`);
    expect(() => extractBlobsScript(["$(rm -rf /)"], 10)).toThrow();
  });
});

describe("tool result media", () => {
  const png = Buffer.from("png bytes");
  it("reads Claude's and MCP's image blocks and Claude's PDF documents", () => {
    expect(blockMedia({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }))
      .toEqual({ sha: gitBlobSha(png), mediaType: "image/png", bytes: png });
    expect(blockMedia({ type: "image", data: png.toString("base64"), mimeType: "image/jpeg" })).toMatchObject({ mediaType: "image/jpeg" });
    expect(blockMedia({ type: "document", source: { type: "base64", media_type: "application/pdf", data: png.toString("base64") } }))
      .toMatchObject({ mediaType: "application/pdf" });
  });

  it("skips URLs, unknown types and empty data", () => {
    expect(blockMedia({ type: "image", source: { type: "url", url: "https://x/y.png" } })).toBeUndefined();
    expect(blockMedia({ type: "image", source: { type: "base64", media_type: "text/html", data: png.toString("base64") } })).toBeUndefined();
    expect(blockMedia({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } })).toBeUndefined();
    expect(blockMedia({ type: "text", text: "hi" })).toBeUndefined();
  });

  it("puts references on the event and leaves events without media alone", () => {
    const event = { kind: "tool_result" as const, message: "[image]", data: { toolUseId: "t1", isError: false } };
    expect(withMedia(event, "plain text")).toBe(event);
    const withImage = withMedia(event, [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }]);
    expect(withImage.data).toEqual({ toolUseId: "t1", isError: false, media: [{ sha: gitBlobSha(png), mediaType: "image/png" }] });
    expect(withImage.media).toHaveLength(1);
  });
});
