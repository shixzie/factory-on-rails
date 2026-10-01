import type { Metadata } from "next";
import { Suspense } from "react";
import { Composer } from "@/components/composer";
import { ComposerSkeleton } from "@/components/composer-skeleton";
import { Logo } from "@/components/logo";
import { PageHeader } from "@/components/page-header";
import { getMe, getRepos, getRuns } from "@/lib/server";

export const metadata: Metadata = { title: "New run" };

type Props = { searchParams: Promise<{ repo?: string | string[]; draft?: string | string[] }> };

async function NewRunComposer({ searchParams }: Props) {
  const [me, { repos, error }, runs, params] = await Promise.all([getMe(), getRepos(), getRuns(), searchParams]);
  const requestedRepo = Array.isArray(params.repo) ? params.repo[0] : params.repo;
  const draft = Array.isArray(params.draft) ? params.draft[0] : params.draft;
  const recent = runs.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  // A project link starts a fresh draft, while agent preferences still use the most recent run.
  return (
    <Composer
      key={JSON.stringify([requestedRepo, draft])}
      me={me}
      repos={repos}
      reposError={error}
      requestedRepo={requestedRepo}
      defaultRepo={recent?.repo}
      defaultAgent={recent?.agent}
      defaultModel={recent?.model}
      defaultReasoningEffort={recent?.reasoningEffort}
      autoFocus
    />
  );
}

export default function NewRunPage({ searchParams }: Props) {
  return (
    <>
      <PageHeader>
        <span className="font-medium">New run</span>
      </PageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 pb-[12vh]">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo className="size-9 rounded-lg [&_svg]:size-5" />
          <h1 className="text-xl font-medium tracking-tight">What should the factory build?</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Each run gets its own Railway sandbox, works on a fresh branch, and comes back as a pull request.
          </p>
        </div>
        <Suspense fallback={<ComposerSkeleton />}>
          <NewRunComposer searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}
