"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { useSidebar } from "@/components/ui/sidebar";

/** A new draft needs a new identity, even when this project's composer is already open. */
export function NewThreadLink({ repo, ...props }: Omit<ComponentProps<typeof Link>, "href"> & { repo?: string }) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const href = repo === undefined ? "/" : `/?repo=${encodeURIComponent(repo)}`;
  return (
    <Link
      {...props}
      href={href}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === "_blank") return;
        event.preventDefault();
        setOpenMobile(false);
        router.push(`${href}${repo === undefined ? "?" : "&"}draft=${crypto.randomUUID()}`);
      }}
    />
  );
}
