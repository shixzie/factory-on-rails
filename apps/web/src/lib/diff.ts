/** Parses `git diff` output into files and hunks for the files-changed panel. */

export type DiffLineType = "add" | "del" | "ctx" | "note";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Set when the file was renamed. */
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const unquote = (p: string) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, "$1") : p);
const stripPrefix = (p: string) => unquote(p).replace(/^[ab]\//, "");

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = {
        path: m?.[2] ?? line.slice(11),
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(line.slice(12));
      } else if (line.startsWith("rename to ")) file.path = unquote(line.slice(10));
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") file.path = stripPrefix(line.slice(4));
    }

    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), newNo: newNo++ });
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++ });
      file.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "note", text: line });
    }
  }
  return files;
}

export function diffTotals(files: ReadonlyArray<DiffFile>) {
  return files.reduce(
    (t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
}

/** A before/after pair (an Edit tool call) as diff lines, without line numbers. */
export function replacementLines(before: string, after: string): DiffLine[] {
  const split = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
  return [
    ...split(before).map((text): DiffLine => ({ type: "del", text })),
    ...split(after).map((text): DiffLine => ({ type: "add", text })),
  ];
}
