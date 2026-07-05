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
        This Privacy Policy explains what personal information the Unicorn Idea
        Filter / Cash Cow Filter (the &ldquo;Service&rdquo;) collects, how we use
        and share it, and the choices you have. The Service is operated by
        Innovate Abundance LLC (&ldquo;we,&rdquo; &ldquo;us&rdquo;), which is the
        controller of the information described here. By using the Service you
        agree to this Policy, which forms part of our{" "}
        <Link href="/terms" className="text-teal-700 underline">
          Terms of Service
        </Link>
        .
      </p>

      <Section title="1. Information you provide">
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Ideas and content.</strong> Idea descriptions, scores, gate
            answers, clarifying questions and answers, your founder background,
            and any CV or document files you upload.
          </li>
          <li>
            <strong>Account information.</strong> If you create an account, your
            email address and any display name or handle you set.
          </li>
          <li>
            <strong>Communications.</strong> Anything you send us, such as
            support requests.
          </li>
        </ul>
      </Section>

      <Section title="2. Information collected automatically">
        <p>
          Even without an account, when you add or analyze an idea we record
          technical and usage data for security, abuse-prevention, and
          fair-use enforcement: your IP address, a device identifier, your
          browser and user-agent, the referring page, an approximate location
          (country and city derived from your IP address), and timestamps and
          which actions you took. This information is visible to the site
          administrator and is <strong>not shared publicly</strong>.
        </p>
        <p>
          We also store a small amount of data in your browser (see Cookies &amp;
          local storage below).
        </p>
      </Section>

      <Section title="3. Payment information">
        <p>
          Subscriptions are processed by Stripe. Stripe collects and processes
          your payment details directly under its own privacy policy; we never
          receive or store your full card number. We retain only a Stripe
          customer and subscription identifier and your subscription status so we
          can provide paid features.
        </p>
      </Section>

      <Section title="4. How we use your information">
        <p>We use the information above to:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>run the scoring and generate AI analysis you request;</li>
          <li>create, operate, and secure your account and subscription;</li>
          <li>
            enforce usage limits and prevent fraud, abuse, and other harmful
            activity;
          </li>
          <li>respond to your requests and provide support;</li>
          <li>maintain, debug, and improve the Service;</li>
          <li>comply with legal obligations and enforce our Terms.</li>
        </ul>
        <p>
          Where the GDPR or similar laws apply, we rely on these legal bases:
          performing our contract with you (providing the Service), our
          legitimate interests (securing and improving the Service, preventing
          abuse), your consent where required, and compliance with legal
          obligations.
        </p>
      </Section>

      <Section title="5. AI processing">
        <p>
          To generate analysis, the idea text and founder background you submit
          are transmitted to third-party AI providers (Anthropic and/or OpenAI,
          depending on the model selected). Where enabled, the model may perform
          live web searches related to your idea. This data is processed under
          those providers&apos; terms and privacy policies; we do not control
          their independent practices. We do not use uploaded files or your
          content to train our own models.
        </p>
      </Section>

      <Section title="6. What becomes public">
        <p>
          When an idea has been scored it may appear in the Service&apos;s public
          database with its scores, an AI-generated summary, an{" "}
          <strong>anonymised</strong> founder profile (categorical only — no
          names, employers, schools, or locations), and any handle you choose to
          display. Your full founder background, uploaded files, email, and the
          technical/usage data above are never made public. Subscribers can mark
          ideas private to keep them out of the public database entirely.
        </p>
      </Section>

      <Section title="7. Cookies & local storage">
        <p>
          We use a session cookie to keep you signed in, and your browser&apos;s
          local storage to remember your settings and a device identifier used
          for usage limits. These are necessary for the Service to function. We
          do not use third-party advertising cookies or cross-site tracking, and
          we do not sell your information, so we do not respond to
          &ldquo;Do Not Track&rdquo; signals differently.
        </p>
      </Section>

      <Section title="8. How we share information">
        <p>
          We share information only as needed to run the Service, and never sell
          it. Recipients are our service providers acting on our behalf:
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>Supabase — database, authentication, and file storage;</li>
          <li>Vercel — application hosting and delivery;</li>
          <li>Stripe — payment processing;</li>
          <li>Anthropic and OpenAI — AI analysis.</li>
        </ul>
        <p>
          We may also disclose information if required by law or valid legal
          process, to protect our rights, users, or the public, or in connection
          with a merger, acquisition, or sale of assets (with this Policy
          continuing to apply to the transferred information).
        </p>
      </Section>

      <Section title="9. International transfers">
        <p>
          We and our providers are based in, or process data in, the United
          States and potentially other countries. If you access the Service from
          outside those countries, your information may be transferred to and
          processed in jurisdictions whose data-protection laws differ from your
          own. Where required, we rely on appropriate safeguards for such
          transfers.
        </p>
      </Section>

      <Section title="10. Data retention">
        <p>
          We keep your information for as long as needed to provide the Service
          and for the purposes above. Account and idea data are retained until
          you delete them or close your account. For security and
          abuse-prevention, certain records — including uploaded files and
          submission logs — may be retained <strong>even after you delete an
          idea</strong>. Short-lived anti-abuse records (such as anonymous
          usage counters) are cleaned up automatically after a short period. We
          may retain information longer where required by law.
        </p>
      </Section>

      <Section title="11. Security">
        <p>
          We take reasonable technical and organizational measures to protect
          your information — including access controls, encryption in transit,
          and a server-side architecture that restricts direct write access to
          your data. No method of transmission or storage is completely secure,
          however, and we cannot guarantee absolute security.
        </p>
      </Section>

      <Section title="12. Your rights & choices">
        <p>
          You can access, correct, export, or delete much of your data directly
          from Settings, and you can cancel your subscription there at any time.
          You may also email us to request access, correction, deletion
          (including retained files and logs), a copy of your data, or to object
          to or restrict certain processing.
        </p>
        <p>
          Depending on where you live, you may have additional rights under laws
          such as the EU/UK GDPR (access, rectification, erasure, portability,
          restriction, objection, and the right to complain to a supervisory
          authority) or the CCPA/CPRA (to know, delete, correct, and opt out of
          &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; — which we do not do). We
          will not discriminate against you for exercising these rights and will
          respond within the timeframes the applicable law requires.
        </p>
      </Section>

      <Section title="13. Children">
        <p>
          The Service is not intended for anyone under 18, and we do not
          knowingly collect personal information from children. If you believe a
          child has provided us information, contact us and we will delete it.
        </p>
      </Section>

      <Section title="14. Changes & contact">
        <p>
          We may update this Policy from time to time; the date above reflects
          the latest version, and we will provide notice in the app for material
          changes. For any privacy question or to exercise a right, contact us at{" "}
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
