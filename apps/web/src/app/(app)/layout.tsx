import { cookies } from "next/headers";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getMe, getRuns, getSetup } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, runs, setup, jar] = await Promise.all([getMe(), getRuns(), getSetup(), cookies()]);
  const open = jar.get("sidebar_state")?.value !== "false";
  return (
    <SidebarProvider defaultOpen={open}>
      <AppSidebar me={me} runs={runs} />
      <SidebarInset className="min-h-svh min-w-0">
        {setup.sandboxes.ready ? null : (
          <p className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm">
            Runs can't start until sandboxes are connected.{" "}
            <Link href="/setup" className="font-medium underline underline-offset-4">
              Finish setup
            </Link>
          </p>
        )}
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
