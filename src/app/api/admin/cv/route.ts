// Admin: every uploaded CV (retained even after a founder clears their
// background), with a short-lived signed download URL for the stored file.
import { adminClient, cloudConfigured, resolveCaller } from "@/lib/supabase/server";

interface CvUploadRow {
  id: string;
  user_id: string | null;
  anon_key: string | null;
  founder_slot: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  storage_path: string | null;
  source_url: string | null;
  web_searches: number | null;
  extracted_text: string;
  ai_summary: string;
  provider: string | null;
  model: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  city: string | null;
  created_at: string;
}

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
    .from("cv_uploads")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as CvUploadRow[];

  // Resolve owner emails and per-file signed URLs (1 hour).
  const ownerIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const emails = new Map<string, string>();
  if (ownerIds.length) {
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, email")
      .in("id", ownerIds as string[]);
    for (const p of profiles ?? []) emails.set(p.id, p.email ?? p.id);
  }

  const uploads = await Promise.all(
    rows.map(async (r) => {
      let downloadUrl: string | null = null;
      if (r.storage_path) {
        const { data: signed } = await admin.storage
          .from("cv-uploads")
          .createSignedUrl(r.storage_path, 3600);
        downloadUrl = signed?.signedUrl ?? null;
      }
      return {
        ...r,
        owner_email: r.user_id ? (emails.get(r.user_id) ?? r.user_id) : null,
        download_url: downloadUrl,
      };
    }),
  );

  return Response.json({ uploads, page, pageSize, total: count ?? uploads.length });
}
