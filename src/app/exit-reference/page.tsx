"use client";

import { useState } from "react";
import { PageHeader, Section } from "@/components/ui";
import { BENCHMARKS } from "./benchmarks";

/** Format a $M figure: one decimal, rolls up to $B at ≥1000 (e.g. "$125.0M", "$2.0B"). */
function fmtMillions(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return "—";
  if (m >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m.toFixed(1)}M`;
}

function parseNum(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const SCENARIO_MULTIPLES: { multiple: number; useWhen: string }[] = [
  { multiple: 3, useWhen: "Services-heavy or low-margin revenue mix" },
  { multiple: 5, useWhen: "Vertical SaaS or fintech infrastructure" },
  { multiple: 8, useWhen: "Strong software or infrastructure business" },
  { multiple: 12, useWhen: "Exceptional category leader with elite growth" },
];

const SCENARIO_VALUATION_M = 1000; // $1B exit

function NumberField({
  label,
  suffix,
  value,
  onChange,
}: {
  label: string;
  suffix: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="tnum h-9 w-full rounded border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none focus:border-teal-600 focus:ring-1 focus:ring-teal-600"
        />
        <span className="shrink-0 text-xs text-zinc-500">{suffix}</span>
      </div>
    </label>
  );
}

function Output({
  label,
  value,
  formula,
}: {
  label: string;
  value: string;
  formula: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
      <div className="text-xs font-medium text-zinc-600">{label}</div>
      <div className="tnum mt-1 text-3xl font-semibold tracking-tight text-zinc-900">
        {value}
      </div>
      <div className="mt-1 text-xs text-zinc-500">{formula}</div>
    </div>
  );
}

function BulletList({
  items,
  markerClass = "text-zinc-400",
}: {
  items: string[];
  markerClass?: string;
}) {
  return (
    <ul className="tnum space-y-2 text-sm text-zinc-700">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span
            aria-hidden
            className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current ${markerClass}`}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ExitReferencePage() {
  const [valuationStr, setValuationStr] = useState("1000");
  const [multipleStr, setMultipleStr] = useState("8");
  const [ownershipStr, setOwnershipStr] = useState("10");
  const [selected, setSelected] = useState(0);

  const valuation = parseNum(valuationStr);
  const multiple = parseNum(multipleStr);
  const ownership = parseNum(ownershipStr);

  const requiredRevenue =
    valuation !== null && multiple !== null && multiple > 0
      ? valuation / multiple
      : null;

  const personalProceeds =
    valuation !== null && ownership !== null
      ? valuation * (ownership / 100)
      : null;

  const entry = BENCHMARKS[selected];

  return (
    <div>
      <PageHeader
        title="Exit calculations & References"
        description="Background reading — work backwards from the exit you want, and see what a $1B outcome demands per business model."
      />

      <div className="space-y-6">
        <Section
          title="Exit math"
          description="Valuation, multiple, and ownership determine the revenue bar and what you take home."
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumberField
              label="Target valuation"
              suffix="$M"
              value={valuationStr}
              onChange={setValuationStr}
            />
            <NumberField
              label="Revenue multiple"
              suffix="x"
              value={multipleStr}
              onChange={setMultipleStr}
            />
            <NumberField
              label="Expected ownership at exit"
              suffix="%"
              value={ownershipStr}
              onChange={setOwnershipStr}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Output
              label="Required revenue"
              value={fmtMillions(requiredRevenue)}
              formula="Target valuation ÷ revenue multiple"
            />
            <Output
              label="Personal proceeds"
              value={fmtMillions(personalProceeds)}
              formula="Target valuation × ownership at exit"
            />
          </div>
        </Section>

        <Section
          title="Multiple scenarios ($1B exit)"
          description="The revenue a $1B outcome demands at different revenue multiples."
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4">Multiple</th>
                  <th className="py-2 pr-4">Required revenue for $1B</th>
                  <th className="py-2">Use when</th>
                </tr>
              </thead>
              <tbody>
                {SCENARIO_MULTIPLES.map(({ multiple: m, useWhen }) => {
                  const active = multiple !== null && multiple === m;
                  return (
                    <tr
                      key={m}
                      className={`border-b border-zinc-100 last:border-b-0 ${
                        active ? "bg-teal-50" : ""
                      }`}
                    >
                      <td className="tnum py-2.5 pr-4 font-medium text-zinc-900">
                        {m}x
                      </td>
                      <td className="tnum py-2.5 pr-4 text-zinc-900">
                        {fmtMillions(SCENARIO_VALUATION_M / m)}
                      </td>
                      <td className="py-2.5 text-zinc-600">{useWhen}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Revenue multiples compress as growth slows and margins thin —
            sanity-check any assumed multiple against comparable public
            companies before relying on it.
          </p>
        </Section>

        <div>
          <h2 className="text-base font-semibold tracking-tight text-zinc-900">
            Benchmarks by business model
          </h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            What a $1B outcome demands per business model.
          </p>

          <div className="mb-5 mt-3 border-b border-zinc-200">
            <div
              className="-mb-px flex gap-1 overflow-x-auto"
              role="tablist"
              aria-label="Business model"
            >
              {BENCHMARKS.map((b, i) => (
                <button
                  key={b.model}
                  role="tab"
                  aria-selected={i === selected}
                  onClick={() => setSelected(i)}
                  className={`min-h-8 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
                    i === selected
                      ? "border-teal-600 font-medium text-teal-700"
                      : "border-transparent text-zinc-500 hover:text-zinc-900"
                  }`}
                >
                  {b.model}
                </button>
              ))}
            </div>
          </div>

          <p className="mb-4 text-sm text-zinc-600">{entry.oneLiner}</p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Section title="$1B logic">
              <p className="tnum text-sm leading-relaxed text-zinc-700">
                {entry.billionLogic}
              </p>
            </Section>

            <Section title="IPO-quality targets">
              <BulletList items={entry.ipoTargets} />
            </Section>

            <Section title="Early proof signals">
              <BulletList items={entry.earlyProof} />
            </Section>

            <Section title="Kill risks">
              <BulletList items={entry.killRisks} markerClass="text-red-600" />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
