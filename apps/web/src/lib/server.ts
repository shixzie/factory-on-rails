import "server-only";
import { Effect, Either } from "effect";
import type { HttpClient } from "@effect/platform";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { api, clientLayer, type Api, type ApiRequestError } from "./api";

/** Where the harness listens on the private network. */
export const harnessUrl = () => (process.env.HARNESS_INTERNAL_URL ?? "http://localhost:3001").replace(/\/$/, "");

/**
 * Runs an API call from a server component as the visitor (their session
 * cookie is forwarded). Signed-out visitors go to /login and an expired GitHub
 * sign-in restarts the OAuth flow; any other failure is returned.
 */
export async function serverApiEither<A>(
  effect: Effect.Effect<A, ApiRequestError, HttpClient.HttpClient>,
): Promise<Either.Either<A, ApiRequestError>> {
  const cookie = (await cookies()).toString();
  const result = await Effect.runPromise(
    effect.pipe(Effect.either, Effect.provide(clientLayer(harnessUrl(), cookie ? { cookie } : {}))),
  );
  if (Either.isLeft(result)) {
    if (result.left.code === "unauthorized") redirect("/login");
    if (result.left.code === "reauth") redirect("/auth/login");
  }
  return result;
}

/** Like `serverApiEither`, but a missing resource renders the 404 page and anything else the error page. */
export async function serverApi<A>(effect: Effect.Effect<A, ApiRequestError, HttpClient.HttpClient>): Promise<A> {
  const result = await serverApiEither(effect);
  if (Either.isRight(result)) return result.right;
  if (result.left.status === 404 || result.left.status === 400) notFound();
  throw new Error(result.left.message);
}

// Deduplicated per request, so the layout and the page can both ask.
export const getMe = cache(() => serverApi(api.me));
export const getRuns = cache(() => serverApi(api.runs));
/** Repositories come from GitHub, so a GitHub hiccup degrades the composer instead of failing the page. */
export const getRepos = cache(async () => {
  const result = await serverApiEither(api.repos);
  return Either.isRight(result)
    ? { repos: result.right, error: null }
    : { repos: [] as ReadonlyArray<Api.ApiRepo>, error: result.left.message };
});
