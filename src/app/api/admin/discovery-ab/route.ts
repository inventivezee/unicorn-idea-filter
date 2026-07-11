// Admin: discovery A/B analysis — compares the generation schools
// (strict design-against-the-instrument vs spirit-of-the-bar) and the
// scoring-panel orderings on outcomes. Sources of truth are the non-pruned
// gen_variant / scoring_variant / reframe_loop events plus the published
// original ideas; only tasks that actually ran under an experiment appear
// in its comparison.
import { DEFAULT_WEIGHTS } from "@/lib/criteria";
import { decision, type Gates, type Scores } from "@/lib/engine";
import { PASSING_DECISIONS } from "@/lib/discovery/config";
import { CRITERION_IDS, GATE_IDS, type Confidence } from "@/lib/types";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 60;

interface Cell {
  tasks: number;
  scored: number;
  passedFirstTry: number;
  rescued: number;
  totalLoops: number;
  scoreSum: number;
  scores: number[];
}

function newCell(): Cell {
  return {
    tasks: 0,
    scored: 0,
    passedFirstTry: 0,
    rescued: 0,
    totalLoops: 0,
    scoreSum: 0,
    scores: [],
  };
}

function summarize(c: Cell) {
  const sorted = [...c.scores].sort((a, b) => a - b);
  return {
    tasks: c.tasks,
    scored: c.scored,
    avgRawScore: c.scored ? Math.round((c.scoreSum / c.scored) * 10) / 10 : null,
    medianRawScore: sorted.length
      ? sorted[Math.floor(sorted.length / 2)]
      : null,
    firstTryPassRate: c.scored
      ? Math.round((c.passedFirstTry / c.scored) * 100)
      : null,
    avgRescueLoops: c.scored
      ? Math.round((c.totalLoops / c.scored) * 100) / 100
      : null,
  };
}

export async function GET() {
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.isAdmin) {
    return Response.json({ error: "Admins only." }, { status: 403 });
  }
  const admin = adminClient();

  // Variant assignments (non-pruned events).
  const { data: events } = await admin
    .from("discovery_events")
    .select("run_id, task_idx, kind, detail")
    .in("kind", ["gen_variant", "scoring_variant", "reframe_loop"])
    .limit(20000);

  const genOf = new Map<string, string>();
  const scoringOf = new Map<string, string>();
  const loopsOf = new Map<string, number>();
  for (const e of events ?? []) {
    const key = `${e.run_id}:${e.task_idx}`;
    try {
      const d = JSON.parse(e.detail ?? "{}") as {
        variant?: string;
        attempt?: number;
      };
      if (e.kind === "gen_variant" && d.variant) genOf.set(key, d.variant);
      if (e.kind === "scoring_variant" && d.variant) {
        scoringOf.set(key, d.variant);
      }
      if (e.kind === "reframe_loop") {
        loopsOf.set(
          key,
          Math.max(loopsOf.get(key) ?? 0, (d.attempt ?? 0) + 1),
        );
      }
    } catch {
      // Malformed event detail — skip.
    }
  }

  // Tasks under the generation experiment + their ORIGINAL ideas.
  const keys = [...genOf.keys()];
  const runIds = [...new Set(keys.map((k) => k.split(":")[0]))];
  const { data: tasks } = await admin
    .from("discovery_tasks")
    .select("run_id, idx, status, idea_original_id")
    .in("run_id", runIds.length ? runIds : ["-"]);

  const ideaIds = (tasks ?? [])
    .map((t) => t.idea_original_id)
    .filter(Boolean) as string[];
  const { data: ideas } = ideaIds.length
    ? await admin
        .from("ideas")
        .select("id, gates, scores, confidence, raw_score")
        .in("id", ideaIds)
    : { data: [] as Array<Record<string, unknown>> };
  const ideaById = new Map((ideas ?? []).map((i) => [i.id as string, i]));

  const byGen: Record<string, Cell> = {};
  const byCell: Record<string, Cell> = {};
  for (const t of tasks ?? []) {
    const key = `${t.run_id}:${t.idx}`;
    const gv = genOf.get(key);
    if (!gv) continue;
    const sv = scoringOf.get(key) ?? "?";
    const cells = [
      (byGen[gv] ??= newCell()),
      (byCell[`${gv}×${sv}`] ??= newCell()),
    ];
    const idea = t.idea_original_id
      ? (ideaById.get(t.idea_original_id) as
          | {
              gates?: Record<string, unknown>;
              scores?: Record<string, unknown>;
              confidence?: number | null;
              raw_score?: number | null;
            }
          | undefined)
      : undefined;
    for (const c of cells) {
      c.tasks++;
      if (!idea || idea.raw_score === null || idea.raw_score === undefined) {
        continue;
      }
      c.scored++;
      c.scoreSum += idea.raw_score;
      c.scores.push(idea.raw_score);
      const gates = {} as Gates;
      for (const id of GATE_IDS) {
        const v = idea.gates?.[id];
        gates[id] = v === "Y" || v === "N" ? v : null;
      }
      const scores = {} as Scores;
      for (const id of CRITERION_IDS) {
        const v = idea.scores?.[id];
        scores[id] = typeof v === "number" ? v : null;
      }
      const conf = idea.confidence;
      const dec = decision({
        name: "",
        gates,
        scores,
        confidence: (conf === 0.5 || conf === 0.75 || conf === 1.0
          ? conf
          : null) as Confidence,
        weights: DEFAULT_WEIGHTS,
      });
      if (dec && PASSING_DECISIONS.has(dec)) c.passedFirstTry++;
      const loops = loopsOf.get(key) ?? 0;
      c.totalLoops += Math.max(0, loops - 1); // loops beyond the first scoring
      if (loops > 1) c.rescued++;
    }
  }

  return Response.json({
    generatedAt: new Date().toISOString(),
    byGenVariant: Object.fromEntries(
      Object.entries(byGen).map(([k, v]) => [k, summarize(v)]),
    ),
    byGenAndScoringVariant: Object.fromEntries(
      Object.entries(byCell).map(([k, v]) => [k, summarize(v)]),
    ),
  });
}
