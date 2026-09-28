import { describe, expect, it } from "@effect/vitest";
import { isAllowedLogin } from "../src/auth.js";

describe("isAllowedLogin", () => {
  it("admits any GitHub account with *", () => {
    expect(isAllowedLogin(["*"], "Anyone")).toBe(true);
  });

  it("matches listed logins case-insensitively and refuses the rest", () => {
    expect(isAllowedLogin(["shixzie"], "Shixzie")).toBe(true);
    expect(isAllowedLogin(["shixzie"], "mallory")).toBe(false);
  });

  it("refuses everyone when the list is empty", () => {
    expect(isAllowedLogin([], "shixzie")).toBe(false);
  });
});
