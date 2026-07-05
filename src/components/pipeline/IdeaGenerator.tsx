"use client";

// "Help me generate" — filter-aware ideation on the Pipeline page. Describe an
// industry (or leave it blank to work from the founder's background + live
// trend research) and get 5 ideas matched to the active instrument's bar:
// unicorn = big-TAM VC-style, cash cow = profitable PE-style. Each idea can be
// added to the pipeline in one click.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { isPremiumModel } from "@/lib/entitlements";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui";

interface GeneratedIdea {
  name: string;
  pitch: string;
  domain: string;
  businessModel: string;
  buyerICP: string;
  initialWedge: string;
  whyNow: string;
  whyYou: string;
}

interface StoredGen {
  ideas: GeneratedIdea[] | null;
  added: Record<number, string>;
  industry: string;
}

// A generation run costs a credit and takes minutes — survive navigation by
// keeping the last batch per filter in sessionStorage.
function loadGen(filter: string): StoredGen | null {
  try {
    const raw = sessionStorage.getItem(`idea-gen:${filter}`);
    return raw ? (JSON.parse(raw) as StoredGen) : null;
  } catch {
    return null;
  }
}

function saveGen(filter: string, gen: StoredGen): void {
  try {
    sessionStorage.setItem(`idea-gen:${filter}`, JSON.stringify(gen));
  } catch {
    // Storage unavailable — results just won't survive navigation.
  }
}

const COPY = {
  unicorn: {
    tagline:
      "Venture-scale ideas: big TAM, category-defining, VC-fundable. Describe an industry — or leave it blank and I'll work from your founder background and live trend research.",
    button: "Generate unicorn ideas",
    loading:
      "Researching current trends and generating venture-scale ideas — this can take a minute or two…",
  },
  cashcow: {
    tagline:
      "Profitable, PE-style cash cows: rich margins, founder-controlled, durable niches. Describe an industry — or leave it blank and I'll work from your founder background and live trend research.",
    button: "Generate cash cow ideas",
    loading:
      "Researching current trends and generating cash-cow ideas — this can take a minute or two…",
  },
} as const;

export function IdeaGenerator() {
  const { state, addIdea } = useStore();
  const router = useRouter();
  const settings = state.settings;
  const filter = settings.filterMode;
  const cashcow = filter === "cashcow";
  const activeSpec =
    filter === "custom"
      ? settings.customFilters.find(
          (f) => f.id === settings.activeCustomFilterId,
        )
      : undefined;
  const copy = activeSpec
    ? {
        tagline: `Ideas matched to your own bar — ${activeSpec.question} Describe an industry, or leave it blank and I'll work from your background and live trend research.`,
        button: "Generate ideas for my filter",
        loading:
          "Researching current trends and generating ideas matched to your filter — this can take a minute or two…",
      }
    : COPY[filter === "custom" ? "unicorn" : filter];

  const [industry, setIndustry] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideas, setIdeas] = useState<GeneratedIdea[] | null>(null);
  /** Generated-idea index → the pipeline id it was added under. */
  const [added, setAdded] = useState<Record<number, string>>({});

  const storageKey = activeSpec ? `custom:${activeSpec.id}` : filter;
  // Restore this filter's last batch (mount + mode switches). Saving happens
  // at explicit mutation points, NOT in an effect — an effect-based save runs
  // with the initial empty state during StrictMode's double-invoke and would
  // clobber the stored batch before the restore's setState lands.
  useEffect(() => {
    const stored = loadGen(storageKey);
    setIdeas(stored?.ideas ?? null);
    setAdded(stored?.added ?? {});
    setIndustry(stored?.industry ?? "");
    setError(null);
  }, [storageKey]);

  const hasBackground = settings.founderBackground.trim().length > 0;
  const accent = cashcow
    ? {
        border: "border-amber-200",
        chip: "bg-amber-50 text-amber-700",
        spinner: "border-t-amber-500",
      }
    : activeSpec
      ? {
          border: "border-violet-200",
          chip: "bg-violet-50 text-violet-700",
          spinner: "border-t-violet-500",
        }
      : {
          border: "border-teal-200",
          chip: "bg-teal-50 text-teal-700",
          spinner: "border-t-teal-600",
        };

  async function generate() {
    if (loading) return;
    if (!industry.trim() && !hasBackground) {
      setError(
        "Describe an industry above, or add your founder background in Settings so I can work from your edge.",
      );
      return;
    }
    setError(null);
    setLoading(true);
    setIdeas(null);
    setAdded({});
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter,
          ...(activeSpec ? { customSpec: activeSpec } : {}),
          industry,
          founderBackground: settings.founderBackground,
          coFounders: settings.coFounders
            .filter((c) => c.background.trim())
            .map((c) => ({ name: c.name, background: c.background })),
          provider: settings.provider,
          model: settings.models[settings.provider],
          webSearch: settings.webSearch,
          existingNames: state.ideas.map((i) => i.name).filter(Boolean),
          anonKey: getAnonKey(),
        }),
      });
      if (!res.ok) {
        let message = `Couldn't generate ideas (HTTP ${res.status}).`;
        let upgrade = false;
        try {
          const body = (await res.json()) as {
            error?: unknown;
            upgrade?: unknown;
          };
          if (body && typeof body.error === "string" && body.error) {
            message = body.error;
          }
          upgrade = body?.upgrade === true;
        } catch {
          // Non-JSON error body.
        }
        if (upgrade || res.status === 402) {
          const reason = isPremiumModel(settings.models[settings.provider])
            ? "premium"
            : "quota";
          router.push(`/upgrade?reason=${reason}`);
          return;
        }
        setError(message);
        return;
      }
      const data = (await res.json()) as { ideas?: GeneratedIdea[] };
      if (!Array.isArray(data.ideas) || data.ideas.length === 0) {
        setError("No usable ideas came back — try again or add more detail.");
        return;
      }
      setIdeas(data.ideas);
      saveGen(storageKey, { ideas: data.ideas, added: {}, industry });
    } catch {
      setError("Network error while generating ideas.");
    } finally {
      setLoading(false);
    }
  }

  function addToPipeline(idea: GeneratedIdea, index: number) {
    if (added[index]) return;
    const notes =
      idea.pitch +
      (idea.whyNow ? `\n\nWhy now: ${idea.whyNow}` : "") +
      (idea.whyYou ? `\nWhy this founder: ${idea.whyYou}` : "");
    const created = addIdea({
      name: idea.name,
      domain: idea.domain,
      businessModel: idea.businessModel,
      buyerICP: idea.buyerICP,
      initialWedge: idea.initialWedge,
      thesisNotes: notes,
    });
    const nextAdded = { ...added, [index]: created.id };
    setAdded(nextAdded);
    saveGen(storageKey, { ideas, added: nextAdded, industry });
  }

  return (
    <div className={`mb-6 rounded-lg border ${accent.border} bg-white p-4`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">
          Help me generate
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${accent.chip}`}
        >
          {activeSpec
            ? activeSpec.name
            : cashcow
              ? "Cash Cow Filter"
              : "Unicorn Idea Filter"}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-zinc-500">{copy.tagline}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={industry}
          disabled={loading}
          onChange={(e) => {
            setIndustry(e.target.value);
            saveGen(storageKey, { ideas, added, industry: e.target.value });
          }}
          onKeyDown={(e) => {
            // isComposing: IME users confirm compositions with Enter — that
            // must not launch a credit-consuming run.
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              void generate();
            }
          }}
          placeholder={
            hasBackground
              ? "e.g. healthcare back-office, logistics, compliance… or leave blank"
              : "e.g. healthcare back-office, logistics, compliance…"
          }
          className="h-9 min-w-0 flex-1 rounded border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
        />
        <Button variant="primary" onClick={() => void generate()} disabled={loading}>
          {copy.button}
        </Button>
      </div>
      <p className="mt-1.5 text-[10px] text-zinc-400">
        Uses live web research and one AI run from your quota.
      </p>

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
          <span
            aria-hidden
            className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 ${accent.spinner}`}
          />
          {copy.loading}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {ideas ? (
        <div className="mt-4 space-y-3">
          {ideas.map((idea, i) => (
            <div
              key={i}
              className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-900">
                  {idea.name}
                </h3>
                {added[i] ? (
                  <Link
                    href={`/idea/${added[i]}`}
                    className="text-xs font-medium text-teal-700 underline-offset-2 hover:underline"
                  >
                    Added — open ↗
                  </Link>
                ) : (
                  <Button
                    className="px-2 py-1 text-xs!"
                    onClick={() => addToPipeline(idea, i)}
                  >
                    Add to pipeline
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-700">
                {idea.pitch}
              </p>
              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                {idea.buyerICP ? (
                  <div>
                    <dt className="inline font-medium text-zinc-500">
                      Buyer:{" "}
                    </dt>
                    <dd className="inline text-zinc-700">{idea.buyerICP}</dd>
                  </div>
                ) : null}
                {idea.initialWedge ? (
                  <div>
                    <dt className="inline font-medium text-zinc-500">
                      Wedge:{" "}
                    </dt>
                    <dd className="inline text-zinc-700">
                      {idea.initialWedge}
                    </dd>
                  </div>
                ) : null}
                {idea.whyNow ? (
                  <div className="sm:col-span-2">
                    <dt className="inline font-medium text-zinc-500">
                      Why now:{" "}
                    </dt>
                    <dd className="inline text-zinc-700">{idea.whyNow}</dd>
                  </div>
                ) : null}
                {idea.whyYou ? (
                  <div className="sm:col-span-2">
                    <dt className="inline font-medium text-zinc-500">
                      Why you:{" "}
                    </dt>
                    <dd className="inline text-zinc-700">{idea.whyYou}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ))}
          <p className="text-xs text-zinc-400">
            Add the ones worth testing, then run the full analysis from each
            idea&apos;s page.
          </p>
        </div>
      ) : null}
    </div>
  );
}
