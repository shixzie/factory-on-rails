import { describe, expect, it } from "vitest";
import { runTitle } from "../src/lib/format.js";

describe("runTitle", () => {
  it("uses the run's title when it has one", () => {
    expect(runTitle({ title: "Fix the login redirect", task: "the login page loops" })).toBe("Fix the login redirect");
    expect(runTitle({ title: "x".repeat(90), task: "t" }, 60)).toBe(`${"x".repeat(59)}…`);
  });

  it("falls back to the task's first line without its lead-in", () => {
    expect(runTitle({ title: null, task: "please add a README\nwith setup steps" })).toBe("Add a README");
    expect(runTitle({ title: null, task: "Hey, can you fix the flaky test?" })).toBe("Fix the flaky test?");
    expect(runTitle({ title: null, task: "we need to use a smaller model for titles" })).toBe("Use a smaller model for titles");
    expect(runTitle({ title: null, task: "Now is a good time to ship" })).toBe("Now is a good time to ship");
    expect(runTitle({ title: null, task: "Nowhere near done" })).toBe("Nowhere near done");
    expect(runTitle({ title: null, task: "please" })).toBe("please");
    expect(runTitle({ title: null, task: "a".repeat(100) }, 60)).toHaveLength(60);
  });
});
