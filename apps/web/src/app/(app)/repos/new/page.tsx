import type { Metadata } from "next";
import { NewRepoForm } from "@/components/new-repo-form";
import { PageHeader } from "@/components/page-header";
import { getMe } from "@/lib/server";

export const metadata: Metadata = { title: "New repository" };

export default async function NewRepoPage() {
  const me = await getMe();
  return (
    <>
      <PageHeader>
        <span className="font-medium">New repository</span>
      </PageHeader>
      <div className="px-4 py-8">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Created under your GitHub account with an initial commit, so runs can target it right away.
          </p>
          <NewRepoForm installUrl={me.installUrl} />
        </div>
      </div>
    </>
  );
}
