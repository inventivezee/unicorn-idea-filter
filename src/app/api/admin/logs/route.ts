// Admin: submission telemetry (IP, device, backgrounds used, model spend).
import { adminClient, cloudConfigured, resolveCaller } from "@/lib/supabase/server";

export async function GET(request: Request) {
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.isAdmin) {
    return Response.json({ error: "Admin only." }, { status: 403 });
  }
  const url = new URL(request.url);
  const ideaId = url.searchParams.get("idea");
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const pageSize = 100;

  let query = adminClient()
    .from("submission_logs")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (ideaId) query = query.eq("idea_id", ideaId);

  const { data, error, count } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ logs: data ?? [], page, pageSize, total: count ?? 0 });
}
