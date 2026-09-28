import { describe, expect, it } from "vitest";
import { isModelProvider, keyHint, validateApiKey } from "../src/providers.js";

describe("model providers", () => {
  it("knows anthropic and nothing unexpected", () => {
    expect(isModelProvider("anthropic")).toBe(true);
    expect(isModelProvider("toString")).toBe(false);
    expect(isModelProvider("nope")).toBe(false);
  });

  it("validates Anthropic keys", () => {
    expect(validateApiKey("anthropic", "sk-ant-api03-" + "x".repeat(40))).toBeNull();
    expect(validateApiKey("anthropic", "sk-proj-" + "x".repeat(40))).toMatch(/sk-ant-/);
    expect(validateApiKey("anthropic", "sk-ant-short")).toMatch(/complete/);
    expect(validateApiKey("anthropic", "sk-ant-api03-" + "x".repeat(20) + " y")).toMatch(/spaces/);
  });

  it("hints with the last four characters", () => {
    expect(keyHint("sk-ant-api03-abcd1234")).toBe("1234");
  });
});
