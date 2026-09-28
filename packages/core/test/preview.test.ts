import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  Frame,
  openGrant,
  parsePreviewHost,
  previewHost,
  sessionGrant,
  signPreviewGrant,
  tunnelGrant,
  verifyPreviewGrant,
} from "../src/preview.js";

const KEY = "k".repeat(40);
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("preview grants", () => {
  it("verify only with the key, for their kind, until they expire", () => {
    const token = signPreviewGrant(KEY, openGrant(RUN, 5173, "u", 0));
    expect(verifyPreviewGrant(KEY, token, "open", 0)).toMatchObject({ run: RUN, port: 5173, user: "u" });
    expect(verifyPreviewGrant(KEY, token, "session", 0)).toBeUndefined();
    expect(verifyPreviewGrant("x".repeat(40), token, "open", 0)).toBeUndefined();
    expect(verifyPreviewGrant(KEY, token, "open", 61_000)).toBeUndefined();
    expect(verifyPreviewGrant(KEY, undefined, "open")).toBeUndefined();
  });

  it("reject a payload changed after signing", () => {
    const [, sig] = signPreviewGrant(KEY, sessionGrant(RUN, 3000, "u")).split(".");
    const forged = Buffer.from(JSON.stringify(sessionGrant(RUN, 3001, "u"))).toString("base64url");
    expect(verifyPreviewGrant(KEY, `${forged}.${sig}`, "session")).toBeUndefined();
    expect(verifyPreviewGrant(KEY, signPreviewGrant(KEY, tunnelGrant(RUN)), "tunnel")?.run).toBe(RUN);
  });
});

describe("preview hosts", () => {
  it("round-trip a run and port through a host name", () => {
    const host = previewHost("preview.example.com", RUN, 5173);
    expect(host).toBe("p5173-0f8fad5bd9cb469fa16570867728950e.preview.example.com");
    expect(parsePreviewHost("preview.example.com", `${host.toUpperCase()}:443`)).toEqual({ kind: "app", run: RUN, port: 5173 });
    expect(parsePreviewHost("preview.example.com", "tunnel.preview.example.com")).toEqual({ kind: "tunnel" });
  });

  it("ignore hosts that aren't ours or aren't well formed", () => {
    expect(parsePreviewHost("preview.example.com", "factory.example.com")).toBeUndefined();
    expect(parsePreviewHost("preview.example.com", "p0-0f8fad5bd9cb469fa16570867728950e.preview.example.com")).toBeUndefined();
    expect(parsePreviewHost("preview.example.com", "p70000-0f8fad5bd9cb469fa16570867728950e.preview.example.com")).toBeUndefined();
    expect(parsePreviewHost("preview.example.com", "a.p80-0f8fad5bd9cb469fa16570867728950e.preview.example.com")).toBeUndefined();
    expect(parsePreviewHost("preview.example.com", undefined)).toBeUndefined();
  });
});

describe("tunnel frames", () => {
  it("round-trip", () => {
    const frame = decodeFrame(encodeFrame(Frame.Data, 7, Buffer.from("hi")));
    expect(frame).toEqual({ type: Frame.Data, stream: 7, payload: Buffer.from("hi") });
    expect(decodeFrame(Buffer.alloc(3))).toBeUndefined();
  });
});

describe("preview origins", () => {
  it("use https, or http with a port for local development on *.localhost", async () => {
    const { previewOrigin } = await import("../src/preview.js");
    expect(previewOrigin("preview.example.com", RUN, 3000)).toBe("https://p3000-0f8fad5bd9cb469fa16570867728950e.preview.example.com");
    expect(previewOrigin("preview.localhost:8090", RUN, 3000)).toBe("http://p3000-0f8fad5bd9cb469fa16570867728950e.preview.localhost:8090");
    expect(parsePreviewHost("preview.localhost:8090", "p3000-0f8fad5bd9cb469fa16570867728950e.preview.localhost:8090")).toEqual({
      kind: "app",
      run: RUN,
      port: 3000,
    });
  });
});
