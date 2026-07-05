import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — Unicorn Idea Filter",
};

const UPDATED = "July 4, 2026";
const CONTACT = "hk@innovateabundance.com";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-zinc-600">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
        Privacy Policy
      </h1>
      <p className="mt-1 text-xs text-zinc-400">Last updated: {UPDATED}</p>

      <p className="mt-4 text-sm leading-relaxed text-zinc-600">
        This is a plain-language summary of what we collect and why — a starting
        template, not legal advice. The Service is operated by Innovate
        Abundance LLC (&ldquo;we,&rdquo; &ldquo;us&rdquo;).
      </p>

      <Section title="What we collect">
        <p>
          <strong>Ideas and content you enter.</strong> Idea descriptions,
          scores, gate answers, clarifying answers, your founder background, and
          any CV files you upload.
        </p>
        <p>
          <strong>Account information</strong> (if you sign in). Your email
          address, and any display name or handle you set.
        </p>
        <p>
          <strong>Usage &amp; device data — even without an account.</strong>{" "}
          When you add or analyze an idea we record your IP address, a device
          identifier, your browser/user-agent, the referring page, and an
          approximate location (country/city derived from your IP). This is used
          for security, abuse-prevention, and usage limits, and is visible to
          the site administrator. It is <strong>not shared publicly</strong>.
        </p>
        <p>
          <strong>Payment data.</strong> Subscriptions are processed by Stripe.
          We never see or store your full card details — only a customer and
          subscription identifier from Stripe.
        </p>
      </Section>

      <Section title="How we use it">
        <p>
          To run the scoring and analysis, operate your account and
          subscription, enforce fair-use limits, keep the Service secure and
          prevent abuse, and improve the product.
        </p>
      </Section>

      <Section title="AI processing">
        <p>
          To generate analysis, the idea text and founder background you submit
          are sent to third-party AI providers (Anthropic and/or OpenAI,
          depending on the model you select). Where enabled, the model may run
          live web searches. Your data is processed under those providers&apos;
          terms; we don&apos;t control their independent practices.
        </p>
      </Section>

      <Section title="What becomes public">
        <p>
          When an idea has been scored it may appear in the public database with
          its scores, an AI summary, an <strong>anonymised</strong> founder
          profile (categorical only — no names, employers, schools, or
          locations), and any handle you choose to show. Your full founder
          background, uploaded files, and the identifying/usage data above are
          never made public. Paid accounts can mark ideas private to keep them
          out of the public database entirely.
        </p>
      </Section>

      <Section title="Storage & retention">
        <p>
          Data is stored using Supabase (database and file storage) and served
          via Vercel. Uploaded files and submission logs may be retained for
          audit and abuse-prevention <strong>even after you delete an
          idea</strong>. You can request deletion of your data at any time (see
          below).
        </p>
      </Section>

      <Section title="Cookies & local storage">
        <p>
          We use a session cookie to keep you signed in, and your browser&apos;s
          local storage to remember your settings and a device identifier. We do
          not use third-party advertising or cross-site tracking.
        </p>
      </Section>

      <Section title="Who we share with">
        <p>
          We share data only with the processors that run the Service — Supabase
          (hosting/storage), Stripe (payments), Anthropic and OpenAI (AI
          analysis), and Vercel (hosting) — and where required by law. We do not
          sell your data.
        </p>
      </Section>

      <Section title="Your choices & rights">
        <p>
          You can access, correct, export, or delete your data. Ideas and
          account data can be removed from Settings, or email us to request
          deletion (including retained files and logs). Depending on where you
          live, you may have additional rights under laws such as the GDPR or
          CCPA.
        </p>
      </Section>

      <Section title="Children">
        <p>
          The Service isn&apos;t intended for anyone under 18, and we don&apos;t
          knowingly collect data from children.
        </p>
      </Section>

      <Section title="Changes & contact">
        <p>
          We may update this policy; the date above reflects the latest version.
          For any privacy question or request, email{" "}
          <a href={`mailto:${CONTACT}`} className="text-teal-700 underline">
            {CONTACT}
          </a>
          .
        </p>
      </Section>

      <p className="mt-8 text-xs text-zinc-400">
        See also our{" "}
        <Link href="/terms" className="text-teal-700 underline">
          Terms of Service
        </Link>
        .
      </p>
    </div>
  );
}
