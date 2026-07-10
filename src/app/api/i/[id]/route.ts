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
  const idea = data as PublicIdeaRow;
  // Reframe lineage: walk reframe_of back to the original (bounded — the
  // rescue loop caps attempts). Public rows only; a missing hop stops the
  // walk rather than erroring.
  const lineage: Array<{
    id: string;
    name: string;
    reframe_attempt: number;
    raw_score: number | null;
  }> = [];
  let parentId = idea.reframe_of ?? null;
  for (let hop = 0; hop < 8 && parentId; hop++) {
    const { data: parent } = await adminClient()
      .from("public_ideas")
      .select("id, name, reframe_attempt, raw_score, reframe_of")
      .eq("id", parentId)
      .maybeSingle<PublicIdeaRow>();
    if (!parent) break;
    lineage.push({
      id: parent.id,
      name: parent.name,
      reframe_attempt: parent.reframe_attempt ?? 0,
      raw_score: parent.raw_score,
    });
    parentId = parent.reframe_of ?? null;
  }
  return Response.json({ idea, lineage });
}
