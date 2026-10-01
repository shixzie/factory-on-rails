import Image from "next/image";
import { cn } from "@/lib/utils";

/** The shared F-and-rails mark, also used for the browser icon. */
export function Logo({ className }: { className?: string }) {
  return (
    <Image
      src="/logo.svg"
      alt=""
      aria-hidden="true"
      width={64}
      height={64}
      className={cn("size-6 shrink-0", className)}
    />
  );
}
