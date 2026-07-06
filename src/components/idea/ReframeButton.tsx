"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/** Fired by any reframe entry point to tell a mounted <ReframePanel> to scroll
 *  into view and start generating. This lets a reframe button live anywhere on
 *  the page (under the verdict, in the AI summary) while a single panel does the
 *  work — no prop threading between distant components. */
export const REFRAME_EVENT = "unicorn:start-reframe";

export function startReframe(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(REFRAME_EVENT));
  }
}

export function ReframeButton({
  href,
  label = "Reframe this idea",
  variant = "secondary",
  className = "",
}: {
  /** Set for the OWNER of a public idea: navigate to the private editor
   *  (which auto-starts the reframe via ?reframe=1) instead of running inline
   *  on the public page. Left undefined elsewhere → dispatch the start event. */
  href?: string;
  label?: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
}) {
  const router = useRouter();
  return (
    <Button
      variant={variant}
      className={className}
      onClick={() => {
        if (href) router.push(href);
        else startReframe();
      }}
    >
      {label}
    </Button>
  );
}
