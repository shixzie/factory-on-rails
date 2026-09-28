import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { branchName, cloneScript, publishScript, shellQuote, summarizeTask } from "../src/plan.js";

describe("plan helpers", () => {
  it("shell-quotes hostile input", () => {
    const hostile = `it's $(rm -rf /) \`x\` "y"`;
    expect(execFileSync("sh", ["-c", `printf %s ${shellQuote(hostile)}`]).toString()).toBe(hostile);
  });

  it("names branches after the run", () => {
    expect(branchName("0123abcd-0000-0000-0000-000000000000")).toBe("factory/run-0123abcd");
  });

  it("summarizes the first line of a task", () => {
    expect(summarizeTask("Add a health endpoint\n\nDetails...")).toBe("Add a health endpoint");
    expect(summarizeTask("x".repeat(100))).toHaveLength(72);
  });

  it("keeps the token out of the clone script text", () => {
    const script = cloneScript({ repo: "o/r", baseBranch: "main", branch: "factory/run-1", authorName: "A", authorEmail: "a@x" });
    expect(script).toContain('x-access-token:$GH_TOKEN@github.com/o/r.git');
    expect(script).toContain("git checkout -b 'factory/run-1'");
  });

  it("pushes only when the branch moved", () => {
    const script = publishScript({ baseBranch: "main", branch: "factory/run-1" });
    expect(script).toContain("rev-list --count 'origin/main'..HEAD");
    expect(script).toContain("git push -q origin 'HEAD:refs/heads/factory/run-1'");
  });
});
