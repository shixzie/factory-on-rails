import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppJwt } from "../src/github/app.js";
import { authorizeUrl, parseTokenResponse } from "../src/github/oauth.js";

describe("GitHub App JWT", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  it("is a verifiable RS256 token with backdated iat and <10m expiry", () => {
    const jwt = createAppJwt({ appId: "123", privateKeyPem: pem }, 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("OAuth helpers", () => {
  it("builds the authorize URL", () => {
    const url = new URL(authorizeUrl({ clientId: "Iv1.abc" }, "https://h.example/auth/callback", "st8"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://h.example/auth/callback");
    expect(url.searchParams.get("state")).toBe("st8");
  });

  it("parses expiring tokens", () => {
    const t = parseTokenResponse(
      { access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 15897600 },
      0,
    );
    expect(t.accessToken).toBe("ghu_1");
    expect(t.accessTokenExpiresAt?.getTime()).toBe(28_800_000);
    expect(t.refreshToken).toBe("ghr_1");
  });

  it("parses non-expiring tokens", () => {
    const t = parseTokenResponse({ access_token: "ghu_1" });
    expect(t.accessTokenExpiresAt).toBeNull();
    expect(t.refreshToken).toBeNull();
  });

  it("surfaces GitHub errors", () => {
    expect(() => parseTokenResponse({ error: "bad_verification_code", error_description: "The code is wrong" })).toThrow(
      /The code is wrong/,
    );
  });
});
