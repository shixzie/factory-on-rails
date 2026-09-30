import type { Metadata } from "next";
import { Suspense } from "react";
import { Composer } from "@/components/composer";
import { ComposerSkeleton } from "@/components/composer-skeleton";
import { Logo } from "@/components/logo";
import { PageHeader } from "@/components/page-header";
import { getMe, getRepos, getRuns } from "@/lib/server";

export const metadata: Metadata = { title: "New run" };

async function NewRunComposer() {
  const [me, { repos, error }, runs] = await Promise.all([getMe(), getRepos(), getRuns()]);
  // Runs come newest first, so start on the repository and agent used last.
  return <Composer me={me} repos={repos} reposError={error} defaultRepo={runs[0]?.repo} defaultAgent={runs[0]?.agent} defaultModel={runs[0]?.model} defaultReasoningEffort={runs[0]?.reasoningEffort} autoFocus />;
}

export default function NewRunPage() {
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
          <NewRunComposer />
        </Suspense>
      </div>
    </>
  );
}
