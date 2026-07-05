// Public idea feed — reads only the public_ideas view (safe columns:
// no founder data, no rationales, no private/unpublished rows).
import { adminClient, cloudConfigured } from "@/lib/supabase/server";
import type { PublicIdeaRow } from "@/lib/db/types";

const PAGE_SIZE = 30;

export async function GET(request: Request) {
  if (!cloudConfigured()) {
    return Response.json(
      { error: "Cloud features are not configured on this deployment." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const sort = url.searchParams.get("sort") === "top" ? "top" : "new";
  // Which instrument's score ranks "top": unicorn raw_score (default) or the
  // cash-cow cc_raw_score (a view column from migration 006).
  const filter = url.searchParams.get("filter") === "cashcow" ? "cashcow" : "unicorn";

  const admin = adminClient();
  const buildQuery = (topColumn: string) => {
    let q = admin
      .from("public_ideas")
      .select("*", { count: "exact" })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    q =
      sort === "top"
        ? q
            .order(topColumn, { ascending: false, nullsFirst: false })
            .order("id", { ascending: false })
        : q
            .order("created_at", { ascending: false })
            .order("id", { ascending: false });
    return q;
  };

  let { data, error, count } = await buildQuery(
    filter === "cashcow" ? "cc_raw_score" : "raw_score",
  );
  if (error && filter === "cashcow") {
    // Migration 006 not applied yet — the cc columns don't exist. Fall back
    // to the unicorn ranking rather than breaking the feed.
    ({ data, error, count } = await buildQuery("raw_score"));
  }
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as PublicIdeaRow[];
  return Response.json({
    ideas: rows,
    page,
    pageSize: PAGE_SIZE,
    total: count ?? rows.length,
  });
}
