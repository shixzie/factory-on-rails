import { describe, expect, it } from "vitest";
import { capTitle, cleanTitle, GENERATED_TITLE_MAX_CHARS, titleProvider } from "../src/titles.js";

describe("run titles", () => {
  it("cleans what the model answers into a bare title", () => {
    expect(cleanTitle("Add a README")).toBe("Add a README");
    expect(cleanTitle('Title: "Fix the login redirect."')).toBe("Fix the login redirect");
    expect(cleanTitle("**Title:** `Sidebar run titles`\n\nThis names the task.")).toBe("Sidebar run titles");
    expect(cleanTitle("# Move   CI to\tpnpm!")).toBe("Move CI to pnpm");
    expect(cleanTitle("“Rename the harness”")).toBe("Rename the harness");
    expect(cleanTitle("  \n ")).toBeNull();
    expect(cleanTitle('""')).toBeNull();
  });

  it("caps long titles at a word boundary", () => {
    const long = cleanTitle("Refactor the runner so that sandboxes are checkpointed before they are destroyed at the end")!;
    expect(long.length).toBeLessThanOrEqual(GENERATED_TITLE_MAX_CHARS);
    expect(long).toBe("Refactor the runner so that sandboxes are checkpointed");
    expect(capTitle("a".repeat(70), 60)).toBe("a".repeat(60));
    expect(capTitle("Short", 60)).toBe("Short");
  });

  it("names a run with its own agent's provider first, and never with a subscription token", () => {
    expect(titleProvider("claude", ["anthropic", "openai"])).toBe("anthropic");
    expect(titleProvider("codex", ["anthropic", "openai"])).toBe("openai");
    expect(titleProvider("codex", ["anthropic"])).toBe("anthropic");
    expect(titleProvider("claude", ["claude_oauth", "openai"])).toBe("openai");
    expect(titleProvider("claude", ["claude_oauth"])).toBeUndefined();
    expect(titleProvider("claude", [])).toBeUndefined();
  });
});
