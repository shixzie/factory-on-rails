import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import { Logo } from "@/components/logo";
import { ConnectSandboxes, CreateGitHubApp } from "@/components/setup-steps";
import { Button } from "@/components/ui/button";
import { getSetup } from "@/lib/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ error?: string }> };

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 p-4">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
          done ? "border-success/40 bg-success/10 text-success" : "text-muted-foreground",
        )}
        aria-hidden
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h2 className="text-sm font-medium leading-6">
          {title}
          {done ? <span className="sr-only"> (done)</span> : null}
        </h2>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

/**
 * First-run setup for a deployment made from the Railway template: create the
 * GitHub App, sign in, and let the factory create the environment its
 * sandboxes run in. Works signed out, since nobody can sign in before step 1.
 */
export default async function SetupPage({ searchParams }: Props) {
  const [{ error }, setup] = await Promise.all([searchParams, getSetup()]);
  const { githubApp, sandboxes, previews, owners, viewer } = setup;
  const ready = githubApp !== null && sandboxes.ready;

  return (
    <main className="flex min-h-svh flex-col items-center px-4 py-16">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo className="size-10 rounded-xl [&_svg]:size-5" />
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-medium tracking-tight">Set up Factory on Rails</h1>
            <p className="text-sm text-muted-foreground">
              Two things this deployment can't create on its own: a GitHub App to sign in and push with, and the Railway
              environment its sandboxes run in.
            </p>
          </div>
        </div>

        {error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>
        ) : null}

        <ol className="divide-y rounded-xl border bg-card">
          <Step n={1} title="Create the GitHub App" done={githubApp !== null}>
            {githubApp ? (
              <>
                <p>
                  {githubApp.fromEnv ? (
                    <>
                      <span className="font-mono text-foreground">{githubApp.slug}</span> is configured with environment
                      variables.
                    </>
                  ) : (
                    <>
                      Created <span className="font-mono text-foreground">{githubApp.slug}</span>
                      {githubApp.owner ? ` under ${githubApp.owner}` : ""}. Install it on the repositories the factory
                      should work on.
                    </>
                  )}
                </p>
                <div>
                  <Button variant="outline" size="sm" nativeButton={false} render={<a href={githubApp.installUrl} target="_blank" rel="noreferrer" />}>
                    Install on GitHub <ExternalLinkIcon />
                  </Button>
                </div>
              </>
            ) : owners.length === 0 ? (
              <p>
                Set <span className="font-mono text-foreground">ALLOWED_GITHUB_LOGINS</span> on the harness service to your
                GitHub username first. The App has to belong to an account named there, so nobody else can set up this
                deployment.
              </p>
            ) : (
              <>
                <p>
                  Registers a private GitHub App for this factory, with its sign-in callback and permissions filled in.
                  Create it signed in to GitHub as <span className="text-foreground">{owners.join(" or ")}</span> (for an
                  organization, name it here and in <span className="font-mono text-foreground">ALLOWED_GITHUB_LOGINS</span>).
                  GitHub shows you the App before creating it.
                </p>
                <CreateGitHubApp />
              </>
            )}
          </Step>

          <Step n={2} title="Sign in" done={viewer !== null}>
            {viewer ? (
              <p>
                Signed in as <span className="text-foreground">{viewer.login}</span>.
              </p>
            ) : (
              <>
                <p>Sign in with GitHub as the account that owns the App.</p>
                <div>
                  {githubApp ? (
                    <Button size="sm" nativeButton={false} render={<a href="/auth/login" />}>
                      Continue with GitHub
                    </Button>
                  ) : (
                    <Button size="sm" disabled>
                      Continue with GitHub
                    </Button>
                  )}
                </div>
              </>
            )}
          </Step>

          <Step n={3} title="Connect Railway sandboxes" done={sandboxes.ready}>
            {sandboxes.ready ? (
              <p>
                {sandboxes.fromEnv
                  ? "The runner's environment variables say where sandboxes run."
                  : "Sandboxes run in this project's agents environment, with a token that can only reach that environment."}
              </p>
            ) : viewer?.admin ? (
              <>
                <p>
                  The factory creates an empty <span className="font-mono text-foreground">agents</span> environment in this
                  Railway project and a project token scoped to it. Agents' sandboxes run there, away from the factory's own
                  services and database. Sandbox usage is billed to this Railway workspace.
                </p>
                <ConnectSandboxes />
              </>
            ) : viewer ? (
              <p>
                Only an account named in <span className="font-mono text-foreground">ALLOWED_GITHUB_LOGINS</span>, or the
                App's owner, can finish this step.
              </p>
            ) : (
              <p>Sign in first.</p>
            )}
          </Step>

          <Step n={4} title="Previews (optional)" done={previews}>
            {previews ? (
              <p>Run owners can open servers running in their sandbox from the run's Preview tab.</p>
            ) : (
              <p>
                Lets a run's owner open the app the agent is running in its sandbox. It needs a wildcard domain you
                control, so it is set up by hand: see{" "}
                <a
                  href="https://github.com/shixzie/factory-on-rails#previews-optional"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 underline underline-offset-4"
                >
                  Previews in the README <ExternalLinkIcon className="size-3" />
                </a>
                . Everything else works without it.
              </p>
            )}
          </Step>
        </ol>

        {ready ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">
              All set. Save your model API key under Settings, then start your first run.
            </p>
            <Button nativeButton={false} render={<a href="/" />}>Open the factory</Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
