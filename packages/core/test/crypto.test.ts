import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, parseEncryptionKey } from "../src/crypto.js";

describe("token encryption", () => {
  const key = randomBytes(32);

  it("round-trips", () => {
    const payload = encrypt("ghu_secret", key);
    expect(payload).not.toContain("ghu_secret");
    expect(decrypt(payload, key)).toBe("ghu_secret");
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("rejects tampering and wrong keys", () => {
    const payload = encrypt("ghu_secret", key);
    const parts = payload.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });

  it("validates key length", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseEncryptionKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });
});

describe("TokenCipher", () => {
  it("encrypts and decrypts through the service, failing with DecryptError on garbage", async () => {
    const { Effect } = await import("effect");
    const { TokenCipher } = await import("../src/crypto.js");
    const cipher = TokenCipher.fromKey(randomBytes(32));
    const payload = cipher.encrypt("sk-ant-secret");
    expect(await Effect.runPromise(cipher.decrypt(payload))).toBe("sk-ant-secret");
    const error = await Effect.runPromise(Effect.flip(cipher.decrypt("v1.nope.nope.nope")));
    expect(error._tag).toBe("DecryptError");
  });
});
