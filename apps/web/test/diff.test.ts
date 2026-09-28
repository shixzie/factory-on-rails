import { describe, expect, it } from "vitest";
import { diffTotals, parseDiff, replacementLines } from "../src/lib/diff.js";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " import x from 'x';",
  "-const a = 1;",
  "+const a = 2;",
  "+const b = 3;",
  " export { a };",
  "\\ No newline at end of file",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1 @@",
  "+# Hi",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "--- a line that starts with dashes",
  "diff --git a/a.png b/a.png",
  "new file mode 100644",
  "Binary files /dev/null and b/a.png differ",
  "diff --git a/from.ts b/to.ts",
  "similarity index 90%",
  "rename from from.ts",
  "rename to to.ts",
  "",
].join("\n");

describe("parseDiff", () => {
  const files = parseDiff(patch);

  it("finds each file with its status and size", () => {
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ["src/app.ts", "modified", 2, 1, false],
      ["README.md", "added", 1, 0, false],
      ["old.txt", "deleted", 0, 1, false],
      ["a.png", "added", 0, 0, true],
      ["to.ts", "renamed", 0, 0, false],
    ]);
    expect(files[4]!.oldPath).toBe("from.ts");
    expect(diffTotals(files)).toEqual({ additions: 3, deletions: 2 });
  });

  it("numbers old and new lines through a hunk", () => {
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { type: "ctx", text: "import x from 'x';", oldNo: 1, newNo: 1 },
      { type: "del", text: "const a = 1;", oldNo: 2 },
      { type: "add", text: "const a = 2;", newNo: 2 },
      { type: "add", text: "const b = 3;", newNo: 3 },
      { type: "ctx", text: "export { a };", oldNo: 3, newNo: 4 },
      { type: "note", text: "\\ No newline at end of file" },
    ]);
    expect(files[2]!.hunks[0]!.lines[0]).toEqual({ type: "del", text: "-- a line that starts with dashes", oldNo: 1 });
  });

  it("returns nothing for an empty patch", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("replacementLines", () => {
  it("shows an edit as removed then added lines", () => {
    expect(replacementLines("a\nb\n", "c")).toEqual([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" },
    ]);
    expect(replacementLines("", "new")).toEqual([{ type: "add", text: "new" }]);
  });
});
