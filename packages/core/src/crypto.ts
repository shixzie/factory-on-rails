import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Config, ConfigError, Context, Data, Effect, Either, Layer, Redacted } from "effect";

const VERSION = "v1";

/** Parses a base64-encoded 32-byte key (e.g. from `openssl rand -base64 32`). */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error(`Encryption key must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext>, each part base64url. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unrecognized encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** TOKEN_ENCRYPTION_KEY, validated as a base64 32-byte key. */
export const encryptionKeyConfig: Config.Config<Redacted.Redacted<Buffer>> = Config.redacted("TOKEN_ENCRYPTION_KEY").pipe(
  Config.mapOrFail((raw) => {
    try {
      return Either.right(Redacted.make(parseEncryptionKey(Redacted.value(raw))));
    } catch (err) {
      return Either.left(ConfigError.InvalidData(["TOKEN_ENCRYPTION_KEY"], (err as Error).message));
    }
  }),
);

export class DecryptError extends Data.TaggedError("DecryptError")<{ readonly cause: unknown }> {}

/** Encrypts secrets at rest (GitHub user tokens, users' own API keys). */
export class TokenCipher extends Context.Tag("@factory/TokenCipher")<
  TokenCipher,
  {
    readonly encrypt: (plaintext: string) => string;
    readonly decrypt: (payload: string) => Effect.Effect<string, DecryptError>;
  }
>() {
  static fromKey(key: Buffer): Context.Tag.Service<TokenCipher> {
    return {
      encrypt: (plaintext) => encrypt(plaintext, key),
      decrypt: (payload) => Effect.try({ try: () => decrypt(payload, key), catch: (cause) => new DecryptError({ cause }) }),
    };
  }

  static readonly Live = Layer.effect(
    TokenCipher,
    Effect.map(encryptionKeyConfig, (key) => TokenCipher.fromKey(Redacted.value(key))),
  );
}
