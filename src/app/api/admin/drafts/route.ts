// Admin: every draft (unfinished ideas + filter designs) with owner context.
import { cloudConfigured, resolveCaller, adminClient } from "@/lib/supabase/server";
import type { DraftRow } from "@/lib/db/drafts";

export async function GET(request: Request) {
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.isAdmin) {
    return Response.json({ error: "Admin only." }, { status: 403 });
  }
  const url = new URL(request.url);
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const pageSize = 50;

  const admin = adminClient();
  const { data, error, count } = await admin
    .from("drafts")
    .select("*", { count: "exact" })
    .order("updated_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as DraftRow[];
  const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))];
  const emails = new Map<string, string>();
  if (ownerIds.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, email, display_name")
      .in("id", ownerIds as string[]);
    for (const p of profiles ?? []) {
      emails.set(p.id, p.email ?? p.display_name ?? p.id);
    }
  }

  return Response.json({
    drafts: rows.map((r) => ({
      ...r,
      owner_email: r.owner_id ? (emails.get(r.owner_id) ?? r.owner_id) : null,
    })),
    page,
    pageSize,
    total: count ?? rows.length,
  });
}
