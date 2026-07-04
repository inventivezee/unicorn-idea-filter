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

  const admin = adminClient();
  let query = admin
    .from("public_ideas")
    .select("*", { count: "exact" })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  query =
    sort === "top"
      ? query
          .order("raw_score", { ascending: false, nullsFirst: false })
          .order("id", { ascending: false })
      : query
          .order("created_at", { ascending: false })
          .order("id", { ascending: false });

  const { data, error, count } = await query;
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
