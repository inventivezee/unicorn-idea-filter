"use client";

import { Button } from "@/components/ui";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-red-200 bg-white p-6 text-center">
      <h2 className="text-sm font-semibold text-zinc-900">
        Something went wrong rendering this page
      </h2>
      <p className="mt-2 break-words text-xs text-zinc-500">{error.message}</p>
      <div className="mt-4 flex justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button onClick={() => (window.location.href = "/")}>
          Back to Pipeline
        </Button>
      </div>
      <p className="mt-4 text-xs text-zinc-400">
        If this keeps happening after an import, restore a clean backup in
        Settings → Data.
      </p>
    </div>
  );
}
