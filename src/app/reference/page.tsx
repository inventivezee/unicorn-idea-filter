"use client";

import { useState } from "react";
import { PageHeader, Section } from "@/components/ui";
import { BENCHMARKS } from "./benchmarks";

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

export default function ReferencePage() {
  const [selected, setSelected] = useState(0);
  const entry = BENCHMARKS[selected];

  return (
    <div>
      <PageHeader
        title="Reference"
        description="Benchmarks — what a $1B outcome demands per business model."
      />

      <div className="mb-5 border-b border-zinc-200">
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
  );
}
