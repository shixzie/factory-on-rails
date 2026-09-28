import { describe, expect, it } from "vitest";
import { agentCredential, isAgentId, isModelProvider, keyHint, parseSnapshots, snapshotsFor, validateApiKey } from "../src/providers.js";

describe("model providers", () => {
  it("knows its providers and nothing unexpected", () => {
    expect(isModelProvider("anthropic")).toBe(true);
    expect(isModelProvider("claude_oauth")).toBe(true);
    expect(isModelProvider("openai")).toBe(true);
    expect(isModelProvider("toString")).toBe(false);
    expect(isModelProvider("nope")).toBe(false);
  });

  it("validates Anthropic keys", () => {
    expect(validateApiKey("anthropic", "sk-ant-api03-" + "x".repeat(40))).toBeNull();
    expect(validateApiKey("anthropic", "sk-proj-" + "x".repeat(40))).toMatch(/sk-ant-/);
    expect(validateApiKey("anthropic", "sk-ant-short")).toMatch(/complete/);
    expect(validateApiKey("anthropic", "sk-ant-api03-" + "x".repeat(20) + " y")).toMatch(/spaces/);
  });

  it("keeps subscription tokens and API keys apart", () => {
    const token = "sk-ant-oat01-" + "x".repeat(40);
    expect(validateApiKey("claude_oauth", token)).toBeNull();
    expect(validateApiKey("anthropic", token)).toMatch(/subscription token/);
    expect(validateApiKey("claude_oauth", "sk-ant-api03-" + "x".repeat(40))).toMatch(/setup-token/);
  });

  it("validates OpenAI keys", () => {
    expect(validateApiKey("openai", "sk-proj-" + "x".repeat(40))).toBeNull();
    expect(validateApiKey("openai", "pk-" + "x".repeat(40))).toMatch(/sk-/);
  });

  it("hints with the last four characters", () => {
    expect(keyHint("sk-ant-api03-abcd1234")).toBe("1234");
  });
});

describe("agents", () => {
  it("picks the credential each agent should use", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("toString")).toBe(false);
    expect(agentCredential("claude", ["anthropic", "claude_oauth"])).toBe("claude_oauth");
    expect(agentCredential("claude", ["anthropic", "openai"])).toBe("anthropic");
    expect(agentCredential("codex", ["anthropic"])).toBeUndefined();
    expect(agentCredential("codex", ["openai"])).toBe("openai");
  });
});

describe("sandbox snapshots", () => {
  it("parses who may use each snapshot", () => {
    expect(parseSnapshots("shixzie-agents=shixzie|Octo, node-base=*\n")).toEqual({
      snapshots: [
        { name: "shixzie-agents", logins: ["shixzie", "octo"] },
        { name: "node-base", logins: ["*"] },
      ],
      errors: [],
    });
    expect(parseSnapshots("")).toEqual({ snapshots: [], errors: [] });
  });

  it("reports entries it can't use instead of guessing", () => {
    const { snapshots, errors } = parseSnapshots("nobody, run-123=*, bad name=*, ok=a, ok=b");
    expect(snapshots).toEqual([{ name: "ok", logins: ["a"] }]);
    expect(errors).toHaveLength(4);
  });

  it("offers a user only the snapshots declared for them", () => {
    const { snapshots } = parseSnapshots("mine=shixzie, shared=*, theirs=octo");
    expect(snapshotsFor(snapshots, "Shixzie")).toEqual(["mine", "shared"]);
    expect(snapshotsFor(snapshots, "someone")).toEqual(["shared"]);
  });
});
