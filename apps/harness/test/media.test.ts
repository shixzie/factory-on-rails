import { describe, expect, it } from "vitest";
import { byteRange } from "../src/media.js";

describe("byteRange", () => {
  it("reads one range, open-ended and suffix ranges included", () => {
    expect(byteRange("bytes=0-0", 10)).toEqual({ start: 0, end: 0 });
    expect(byteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(byteRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 });
    expect(byteRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(byteRange("bytes=-40", 10)).toEqual({ start: 0, end: 9 });
  });

  it("serves the whole file for no range or several, and refuses ranges outside it", () => {
    expect(byteRange(undefined, 10)).toBeUndefined();
    expect(byteRange("bytes=0-1,4-5", 10)).toBeUndefined();
    expect(byteRange("items=0-1", 10)).toBeUndefined();
    expect(byteRange("bytes=-", 10)).toBeUndefined();
    expect(byteRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 10)).toBe("unsatisfiable");
  });
});
