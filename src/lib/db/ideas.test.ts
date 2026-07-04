import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { insertIdea } from "./ideas";

/** Minimal ideas-table row echoed back by the fake insert. */
function fakeRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner_id: null,
    anon_key: "a".repeat(24),
    name: "Bitfloww",
    domain: "Crypto",
    business_model: "",
    buyer_icp: "",
    initial_wedge: "",
    thesis_notes: "One-step crypto on/off-ramp.",
    gates: {},
    scores: {},
    confidence: null,
    validation_test_30d: "",
    top_risk_override_1: null,
    top_risk_override_2: null,
    ai: null,
    ai_summary: "",
    founder_profile: "",
    is_private: false,
    published: false,
    created_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
    ...over,
  };
}

/**
 * Fake PostgREST that rejects payloads containing columns the "database"
 * doesn't have — the exact failure of a deploy running ahead of migrations.
 */
function fakeAdmin(knownColumns: Set<string>, inserted: unknown[]) {
  return {
    from: () => ({
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            const unknown = Object.keys(row).find((k) => !knownColumns.has(k));
            if (unknown) {
              return {
                data: null,
                error: {
                  code: "PGRST204",
                  message: `Could not find the '${unknown}' column of 'ideas' in the schema cache`,
                },
              };
            }
            inserted.push(row);
            return { data: fakeRow(row), error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const ACTOR = {
  userId: null,
  anonKey: "a".repeat(24),
  isAdmin: false,
  subscribed: false,
};

describe("insertIdea migration-drift tolerance", () => {
  it("saves the idea without a column the database doesn't have yet", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const known = new Set([
      "id", "owner_id", "anon_key", "name", "domain", "business_model",
      "buyer_icp", "initial_wedge", "thesis_notes", "gates", "scores",
      "confidence", "validation_test_30d", "published", "raw_score",
    ]);
    const inserted: Record<string, unknown>[] = [];
    const idea = await insertIdea(fakeAdmin(known, inserted), ACTOR, {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Bitfloww",
      thesisNotes: "One-step crypto on/off-ramp.",
      // The field whose missing column caused the Bitfloww data loss:
      clarifications: [{ question: "Who pays?", answer: "Retail buyers" }],
    });
    expect(idea.name).toBe("Bitfloww");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toHaveProperty("clarifications");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("ideas.clarifications column missing"),
    );
    spy.mockRestore();
  });

  it("still surfaces unrelated errors", async () => {
    const admin = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: "23503", message: "foreign key violation" },
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(
      insertIdea(admin, ACTOR, { name: "X", thesisNotes: "y" }),
    ).rejects.toThrow("foreign key violation");
  });
});
