/** The one byte range a request asks for (`Range: bytes=…`), so video can seek; several ranges get the whole file. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  const [, from = "", to = ""] = match;
  if (from === "") {
    const suffix = Number(to);
    return suffix === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size) return "unsatisfiable";
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
}

/**
 * Media opened on its own (a new tab) must not run script on the app's
 * origin: an SVG can. PDFs are left out because browsers won't show a PDF in
 * a sandboxed document; their viewers don't give a PDF access to the page.
 */
export const mediaHeaders = (mediaType: string): Record<string, string> => ({
  "cache-control": "private, max-age=604800, immutable",
  "x-content-type-options": "nosniff",
  "accept-ranges": "bytes",
  ...(mediaType === "application/pdf"
    ? { "content-disposition": "inline" }
    : { "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }),
});
