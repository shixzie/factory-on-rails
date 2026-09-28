import { ExternalLinkIcon } from "lucide-react";
import type { Metadata } from "next";
import { ApiKeys } from "@/components/api-keys";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { getMe, serverApi } from "@/lib/server";

export const metadata: Metadata = { title: "Settings" };

function Section({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export default async function SettingsPage() {
  const [me, keys] = await Promise.all([getMe(), serverApi(api.keys)]);
  return (
    <>
      <PageHeader>
        <span className="font-medium">Settings</span>
      </PageHeader>
      <div className="px-4 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
          <Section
            title="Model API keys"
            description="Bring your own key: your runs use your key, and only your runs. Keys are encrypted at rest, never shown again after you save them, and only handed to the sandboxes that run your tasks."
          >
            <ApiKeys initial={keys} />
          </Section>
          <Section
            title="Repository access"
            description="The factory works on the repositories you grant its GitHub App. Add or remove repositories on GitHub."
          >
            <div>
              <Button variant="outline" render={<a href={me.installUrl} target="_blank" rel="noreferrer" />}>
                Manage GitHub access <ExternalLinkIcon />
              </Button>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
