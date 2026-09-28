import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchName,
  cloneScript,
  CREDENTIAL_HELPER,
  describePrompt,
  followUpPrompt,
  MAX_DESCRIPTION,
  parsePullRequest,
  pullRequestBody,
  TOKEN_FILE,
  UP_TO_DATE_MARKER,
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

  it("clones without the token in the URL, and picks up a branch an earlier turn pushed", () => {
    const script = cloneScript({ repo: "o/r", baseBranch: "main", branch: "factory/run-1", authorName: "A", authorEmail: "a@x" });
    expect(script).toContain("git clone --depth 50 --branch 'main' https://github.com/o/r.git /workspace/repo");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).toContain(`credential.helper ${shellQuote(CREDENTIAL_HELPER)}`);
    expect(script).toContain("git fetch -q --depth 50 origin 'refs/heads/factory/run-1:refs/remotes/origin/factory/run-1'");
    expect(script).toContain("git checkout -b 'factory/run-1'");
  });

  it("gives git the token from the token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cred-"));
    const helper = CREDENTIAL_HELPER.replace(TOKEN_FILE, join(dir, "token")).slice(1);
    writeFileSync(join(dir, "token"), "ghs_fresh");
    // How git runs a "!" helper: the operation comes after the command.
    const call = (op: string) => execFileSync("sh", ["-c", `${helper} "$@"`, "sh", op]).toString();
    expect(call("get")).toBe("username=x-access-token\npassword=ghs_fresh\n");
    expect(call("store")).toBe("");
  });

  it("exports the current token to every command", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-"));
    const command = withHome('printf %s "${GH_TOKEN:-none}"').replaceAll(TOKEN_FILE, join(dir, "token"));
    const run = () => execFileSync("sh", ["-c", command], { env: { PATH: "/usr/bin:/bin" } }).toString();
    expect(run()).toBe("none");
    writeFileSync(join(dir, "token"), "ghs_fresh");
    expect(run()).toBe("ghs_fresh");
  });

  it("asks the agent only for what's new when it can continue its session", () => {
    expect(followUpPrompt({ task: "Add a README", messages: ["And a license", "MIT"], continuing: true })).toBe("And a license\n\nMIT");
    const fresh = followUpPrompt({ task: "Add a README", messages: ["And a license"], continuing: false });
    expect(fresh).toContain("## The original task\n\nAdd a README");
    expect(fresh).toContain("## What the user asks now\n\nAnd a license");
  });

  it("pushes only when the branch moved", () => {
    const script = publishScript({ baseBranch: "main", branch: "factory/run-1" });
    expect(script).toContain("rev-list --count 'origin/main'..HEAD");
    expect(script).toContain("git push -q origin 'HEAD:refs/heads/factory/run-1'");
    // A later turn with nothing new doesn't push again.
    expect(script).toContain(`rev-parse -q --verify 'refs/remotes/origin/factory/run-1' || true)" ]; then echo ${UP_TO_DATE_MARKER}`);
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

describe("the pull request the agent writes", () => {
  it("reads the first line as the title and the rest as the description", () => {
    expect(parsePullRequest("Retry exec while the sandbox starts\n\nWhy it matters.\n\n## Changes\n- sandbox.ts\n")).toEqual({
      title: "Retry exec while the sandbox starts",
      description: "Why it matters.\n\n## Changes\n- sandbox.ts",
    });
  });

  it("tidies up titles written as a heading, a label or a quote, and unwraps a fenced reply", () => {
    expect(parsePullRequest("\n# Add a README\n\nBody")?.title).toBe("Add a README");
    expect(parsePullRequest("Title: Add a README")).toEqual({ title: "Add a README", description: "" });
    expect(parsePullRequest('**"Add a README"**')?.title).toBe("Add a README");
    expect(parsePullRequest("```markdown\nAdd a README\n\nBody\n```")).toEqual({ title: "Add a README", description: "Body" });
    expect(parsePullRequest("Add a README\r\n\r\nBody")).toEqual({ title: "Add a README", description: "Body" });
  });

  it("has nothing to offer without a title, and caps what it keeps", () => {
    expect(parsePullRequest("")).toBeUndefined();
    expect(parsePullRequest("  \n#\n")).toBeUndefined();
    expect(parsePullRequest("x".repeat(300))!.title).toHaveLength(256);
    const long = parsePullRequest(`Title\n\n${"word ".repeat(5000)}`)!;
    expect(long.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION + 3);
    expect(long.description.endsWith("…")).toBe(true);
  });

  it("asks for the whole branch against its base, and says when the PR already exists", () => {
    const first = describePrompt({ baseBranch: "main", existing: false });
    expect(first).toContain("git diff 'origin/main'...HEAD");
    expect(first).toContain("## How to verify");
    expect(first).toContain(".github/pull_request_template.md");
    expect(first).not.toContain("already has a pull request");
    expect(describePrompt({ baseBranch: "main", existing: true })).toContain("already has a pull request");
  });

  it("puts the agent's description first, with the run and the folded task after it", () => {
    const body = pullRequestBody({ task: "Add a README", runId: "r1", runUrl: "https://f.dev/runs/r1", description: "Adds one.\n" });
    expect(body).toBe(
      "Adds one.\n\n---\n\nOpened by Factory on Rails, run [r1](https://f.dev/runs/r1).\n\n<details><summary>Task</summary>\n\nAdd a README\n\n</details>\n",
    );
    expect(pullRequestBody({ task: "Add a README", runId: "r1" })).toBe("Opened by Factory on Rails, run r1.\n\n### Task\n\nAdd a README\n");
  });
});
