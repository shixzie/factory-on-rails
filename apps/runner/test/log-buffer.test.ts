import { describe, expect, it } from "vitest";
import { redact } from "../src/log-buffer.js";

describe("redact", () => {
  it("scrubs every occurrence of every secret", () => {
    const key = "sk-ant-api03-abcdefghijklmnop";
    expect(redact(`ANTHROPIC_API_KEY=${key}\ntoken ghs_123456789 and ${key}`, [key, "ghs_123456789"])).toBe(
      "ANTHROPIC_API_KEY=[redacted]\ntoken [redacted] and [redacted]",
    );
  });

  it("leaves messages without secrets alone", () => {
    expect(redact("all good", ["sk-ant-secret-value"])).toBe("all good");
  });
});
