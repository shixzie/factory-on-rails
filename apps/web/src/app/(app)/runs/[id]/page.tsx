import type { Metadata } from "next";
import { Suspense } from "react";
import { Composer } from "@/components/composer";
import { ComposerSkeleton } from "@/components/composer-skeleton";
import { RunView } from "@/components/run-view";
import { api } from "@/lib/api";
import { taskTitle } from "@/lib/format";
import { getMe, getRepos, serverApi } from "@/lib/server";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { run } = await serverApi(api.run((await params).id));
  return { title: taskTitle(run.task, 60) };
}

async function FollowUp({ repo, baseBranch }: { repo: string; baseBranch: string }) {
  const [me, { repos, error }] = await Promise.all([getMe(), getRepos()]);
  return (
    <Composer
      me={me}
      repos={repos}
      reposError={error}
      defaultRepo={repo}
      defaultBaseBranch={baseBranch}
      placeholder="Start another run on this repository…"
    />
  );
}

export default async function RunPage({ params }: Props) {
  const detail = await serverApi(api.run((await params).id));
  return (
    <RunView key={detail.run.id} initial={detail}>
      <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent px-4 pt-6 pb-4">
        <Suspense fallback={<ComposerSkeleton />}>
          <FollowUp repo={detail.run.repo} baseBranch={detail.run.baseBranch} />
        </Suspense>
      </div>
    </RunView>
  );
}
