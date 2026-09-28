import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm text-muted-foreground">That page or run doesn&apos;t exist, or isn&apos;t yours.</p>
      <Button variant="outline" render={<Link href="/" />}>
        Back to the factory
      </Button>
    </main>
  );
}
