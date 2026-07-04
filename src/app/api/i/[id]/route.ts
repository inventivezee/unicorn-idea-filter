// Public read-only idea lookup — serves a single row from the public_ideas
// view (safe columns only; private/unpublished ideas are simply not in it).
import type { PublicIdeaRow } from "@/lib/db/types";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cloudConfigured()) {
    return Response.json(
      { error: "Cloud features are not configured on this deployment." },
      { status: 503 },
    );
  }
  const { id } = await params;
  const { data, error } = await adminClient()
    .from("public_ideas")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    // 22P02 = invalid uuid syntax — a malformed id is just "not found".
    if (error.code === "22P02") {
      return Response.json({ error: "Idea not found." }, { status: 404 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Idea not found." }, { status: 404 });
  }
  return Response.json({ idea: data as PublicIdeaRow });
}
