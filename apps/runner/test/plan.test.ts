import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchName,
  cloneScript,
  networkCheckScript,
  publishScript,
  shellQuote,
  summarizeTask,
  withHome,
} from "../src/plan.js";

/** A PATH whose `git` exits with `code`, so scripts can run without a network. */
const fakeGitPath = (code: number) => {
  const dir = mkdtempSync(join(tmpdir(), "fake-git-"));
  writeFileSync(join(dir, "git"), `#!/bin/sh\nexit ${code}\n`);
  chmodSync(join(dir, "git"), 0o755);
  return `${dir}:/usr/bin:/bin`;
};

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

  it("sets HOME only when the shell has none", () => {
    const run = (env: Record<string, string>) =>
      execFileSync("sh", ["-c", withHome('printf %s "$HOME"')], { env: { PATH: "/usr/bin:/bin", ...env } }).toString();
    expect(run({})).toBe("/root");
    expect(run({ HOME: "/home/agent" })).toBe("/home/agent");
  });

  it("waits for GitHub, then gives up with a clear message", () => {
    const script = networkCheckScript({ repo: "o/r", attempts: 2, delaySec: 0 });
    const reachable = spawnSync("sh", ["-c", script], { env: { PATH: fakeGitPath(0) } });
    expect(reachable.status).toBe(0);
    const offline = spawnSync("sh", ["-c", script], { env: { PATH: fakeGitPath(128) } });
    expect(offline.status).toBe(1);
    expect(offline.stderr.toString()).toContain("Cannot reach github.com/o/r from the sandbox");
  });
});
