// CV upload: stores the raw file (cloud mode) in a retained, admin-only record
// and returns an AI-summarised founder background. The file and its record are
// never removed by the app — clearing the background in the UI leaves them.
import { buildCvSummaryPrompt, CV_SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { CV_SUMMARY_SCHEMA } from "@/lib/ai/schema";
import {
  callProviderJSON,
  guardRequest,
  keyMissingResponse,
  mapProviderError,
  modelFromBody,
  parseLastJSON,
  providerFromBody,
} from "@/lib/ai/server";
import {
  DEFAULT_MODEL_FALLBACKS,
  isPremiumModel,
} from "@/lib/entitlements";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 120;

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_TEXT_CHARS = 60_000;
const CV_BUCKET = "cv-uploads";

function safeName(name: string): string {
  return (name || "cv").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected a multipart form." }, { status: 400 });
  }

  const extractedText = String(form.get("extractedText") ?? "")
    .slice(0, MAX_TEXT_CHARS)
    .trim();
  if (!extractedText) {
    return Response.json(
      { error: "No CV text to summarise." },
      { status: 400 },
    );
  }
  const provider = providerFromBody(form.get("provider"));
  const requestedModel = modelFromBody(form.get("model"));
  const anonKey = anonKeyFromBody(form.get("anonKey"));
  const founderSlot = String(form.get("founderSlot") ?? "primary").slice(0, 64);
  const file = form.get("file");
  const uploadFile = file instanceof File ? file : null;

  if (uploadFile && uploadFile.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: "That file is larger than 15 MB." },
      { status: 413 },
    );
  }

  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  // CV summarising is a lightweight helper — never hard-fail behind the
  // paywall. If a premium model is selected without entitlement, quietly fall
  // back to the provider's default free-tier model.
  let model = requestedModel ?? DEFAULT_MODEL_FALLBACKS[provider];
  let subscribed = true; // local-only deployments run on the owner's keys
  const cloud = cloudConfigured();
  // Resolve the caller once and reuse across entitlement + persistence.
  const caller = cloud ? await resolveCaller() : null;
  if (caller) {
    subscribed = caller.subscribed || caller.isAdmin;
    if (isPremiumModel(model) && !subscribed) {
      model = DEFAULT_MODEL_FALLBACKS[provider];
    }
  }

  // Persist the raw file + a retained audit record before summarising, so an
  // upload is always captured even if the AI call later fails.
  let storagePath: string | null = null;
  let uploadId: string | null = null;
  if (cloud) {
    const admin = adminClient();
    uploadId = crypto.randomUUID();
    if (uploadFile) {
      const path = `${caller?.user?.id ?? "anon"}/${uploadId}-${safeName(uploadFile.name)}`;
      const bytes = new Uint8Array(await uploadFile.arrayBuffer());
      const { error: upErr } = await admin.storage
        .from(CV_BUCKET)
        .upload(path, bytes, {
          contentType: uploadFile.type || "application/octet-stream",
          upsert: false,
        });
      if (!upErr) storagePath = path;
      else console.error("cv-upload storage failed", upErr.message);
    }
    const telemetry = requestTelemetry(request);
    const { error: insErr } = await admin.from("cv_uploads").insert({
      id: uploadId,
      user_id: caller?.user?.id ?? null,
      anon_key: caller?.user ? null : anonKey,
      founder_slot: founderSlot,
      filename: uploadFile ? safeName(uploadFile.name) : "",
      mime_type: uploadFile?.type ?? "",
      size_bytes: uploadFile?.size ?? null,
      storage_path: storagePath,
      extracted_text: extractedText,
      provider,
      model,
      ...telemetry,
    });
    if (insErr) console.error("cv_uploads insert failed", insErr.message);
  }

  // Summarise. If the AI call fails, fall back to the raw extracted text so the
  // upload still yields a usable background.
  try {
    const result = await callProviderJSON({
      provider,
      model,
      system: CV_SUMMARY_SYSTEM_PROMPT,
      prompt: buildCvSummaryPrompt(extractedText),
      schemaName: "cv_summary",
      schema: CV_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      webSearch: false,
      speed: "fast",
      tier: subscribed ? "premium" : "standard",
    });
    const raw = parseLastJSON<{ background?: unknown }>(result.texts);
    const background =
      typeof raw.background === "string" && raw.background.trim()
        ? raw.background.trim()
        : extractedText;
    if (cloud && uploadId) {
      const { error: updErr } = await adminClient()
        .from("cv_uploads")
        .update({ ai_summary: background })
        .eq("id", uploadId);
      if (updErr) console.error("cv_uploads summary update failed", updErr.message);
    }
    return Response.json({ background, summarised: background !== extractedText });
  } catch (err) {
    // The file is already saved; return the raw text rather than blocking.
    if (err instanceof Error && /grammar|JSON|parse/i.test(err.message)) {
      return Response.json({ background: extractedText, summarised: false });
    }
    return mapProviderError(err, model);
  }
}
