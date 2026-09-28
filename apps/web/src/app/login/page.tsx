import { Either } from "effect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { serverApiEither } from "@/lib/server";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ error?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  const [{ error }, setup] = await Promise.all([searchParams, serverApiEither(api.setup)]);
  // A fresh deployment has no GitHub App to sign in with yet.
  if (Either.isRight(setup) && setup.right.githubApp === null) redirect("/setup");
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <Logo className="size-10 rounded-xl [&_svg]:size-5" />
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-medium tracking-tight">Factory on Rails</h1>
          <p className="text-sm text-muted-foreground">
            Queue coding tasks against your GitHub repos. Each one runs in its own Railway sandbox and comes back as a
            pull request.
          </p>
        </div>
        {error ? (
          <p className="w-full rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {/* A plain link: sign-in is a full navigation to GitHub, not a client-side route. */}
        <Button size="lg" className="w-full" render={<a href="/auth/login" />}>
          <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Continue with GitHub
        </Button>
        <p className="text-xs text-muted-foreground">Bring your own model key. Sandboxes run on Railway.</p>
      </div>
    </main>
  );
}
