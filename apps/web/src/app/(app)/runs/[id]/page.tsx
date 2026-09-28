import type { Metadata } from "next";
import { RunView } from "@/components/run-view";
import { api } from "@/lib/api";
import { taskTitle } from "@/lib/format";
import { serverApi } from "@/lib/server";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { run } = await serverApi(api.run((await params).id));
  return { title: taskTitle(run.task, 60) };
}

/** A run reads as a conversation: its composer continues it, in the same sandbox while that is kept. */
export default async function RunPage({ params }: Props) {
  const detail = await serverApi(api.run((await params).id));
  return <RunView key={detail.run.id} initial={detail} />;
}
