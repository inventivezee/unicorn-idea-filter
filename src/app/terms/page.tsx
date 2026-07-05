import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service — Unicorn Idea Filter",
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

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
        Terms of Service
      </h1>
      <p className="mt-1 text-xs text-zinc-400">Last updated: {UPDATED}</p>

      <p className="mt-4 text-sm leading-relaxed text-zinc-600">
        These Terms of Service (the &ldquo;Terms&rdquo;) are a binding agreement
        between you and Innovate Abundance LLC (&ldquo;we,&rdquo; &ldquo;us,&rdquo;
        or &ldquo;our&rdquo;) governing your access to and use of the Unicorn
        Idea Filter and Cash Cow Filter web application and related services
        (together, the &ldquo;Service&rdquo;). By accessing or using the
        Service, you agree to these Terms and to our{" "}
        <Link href="/privacy" className="text-teal-700 underline">
          Privacy Policy
        </Link>
        . If you do not agree, do not use the Service.
      </p>

      <Section title="1. Who we are">
        <p>
          The Service is operated by Innovate Abundance LLC, a limited liability
          company organized under the laws of the State of Delaware, USA. You
          can reach us at{" "}
          <a href={`mailto:${CONTACT}`} className="text-teal-700 underline">
            {CONTACT}
          </a>
          .
        </p>
      </Section>

      <Section title="2. Eligibility">
        <p>
          You must be at least 18 years old and able to form a binding contract
          to use the Service. If you use the Service on behalf of a company or
          other organization, you represent that you have authority to bind that
          entity to these Terms.
        </p>
      </Section>

      <Section title="3. What the Service does">
        <p>
          The Service is a decision-support tool. It scores startup and business
          ideas against structured gates and weighted criteria, and can generate
          AI-assisted analysis, summaries, and suggested validation steps. It
          offers two scoring instruments — a venture/&ldquo;unicorn&rdquo;
          filter and a profitability/&ldquo;cash cow&rdquo; (EBITDA) filter.
        </p>
        <p>
          Everything the Service produces is for informational and educational
          purposes only. It is{" "}
          <strong>
            not investment, legal, financial, tax, accounting, or other
            professional advice
          </strong>
          , is not a recommendation to pursue, fund, or abandon any venture, and
          is not a guarantee of any result. You are solely responsible for the
          decisions you make and should conduct your own due diligence and
          consult qualified professionals where appropriate.
        </p>
      </Section>

      <Section title="4. Accounts">
        <p>
          Some features are available without an account; others require you to
          sign in. You agree to provide accurate information, to keep your
          account credentials confidential, and to be responsible for all
          activity that occurs under your account. Notify us promptly of any
          unauthorized use. We may refuse, suspend, or reclaim accounts, or
          usernames/handles, at our reasonable discretion.
        </p>
      </Section>

      <Section title="5. AI-generated content">
        <p>
          Analysis is produced by third-party AI models and, where enabled, live
          web searches. AI output can be inaccurate, incomplete, biased, or out
          of date, and may misstate facts, figures, market sizes, or
          competitors. It is generated automatically and is not reviewed by us
          for accuracy. Treat it as a starting point for your own thinking and
          independently verify anything you rely on.
        </p>
      </Section>

      <Section title="6. Your content & license">
        <p>
          As between you and us, you retain all ownership of the ideas,
          descriptions, backgrounds, files, and other materials you submit
          (&ldquo;Your Content&rdquo;). You grant us a worldwide,
          non-exclusive, royalty-free license to host, store, reproduce,
          process, transmit, and display Your Content, and to create derived
          material such as scores, summaries, and anonymised profiles, solely to
          operate, secure, and improve the Service — including transmitting Your
          Content to our AI and infrastructure providers as described in the{" "}
          <Link href="/privacy" className="text-teal-700 underline">
            Privacy Policy
          </Link>
          .
        </p>
        <p>
          You represent that you have the rights to submit Your Content and that
          it does not infringe anyone&apos;s rights or violate any law. Do not
          submit confidential information belonging to a third party, personal
          data of others without a lawful basis, or anything you are not
          permitted to share.
        </p>
      </Section>

      <Section title="7. The public database">
        <p>
          Once an idea has been scored it may be published to the Service&apos;s
          public database, where other users can see its scores, an AI-generated
          summary, an <strong>anonymised</strong> founder profile (categorical
          only — no names, employers, schools, or locations), and any display
          handle you choose to show. Your full founder background, uploaded
          files, and identifying or usage data are never made public.
          Subscribers can mark ideas private to keep them out of the public
          database entirely. You are responsible for what you choose to submit
          and publish.
        </p>
      </Section>

      <Section title="8. Acceptable use">
        <p>You agree not to, and not to help anyone else:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            use the Service for anything unlawful, deceptive, infringing, or
            harmful;
          </li>
          <li>
            submit content you lack the rights to, or another party&apos;s
            confidential or personal information without authorization;
          </li>
          <li>
            scrape, harvest, resell, sublicense, or commercially exploit the
            Service or its data without our permission;
          </li>
          <li>
            reverse-engineer, decompile, or attempt to extract source code,
            models, or prompts, except where such restriction is prohibited by
            law;
          </li>
          <li>
            circumvent usage limits, quotas, paywalls, authentication, rate
            limits, or other access controls;
          </li>
          <li>
            probe, disrupt, overload, or interfere with the Service, its
            infrastructure, or other users, or introduce malware;
          </li>
          <li>
            use the Service to develop a competing product, or misrepresent your
            affiliation with us.
          </li>
        </ul>
      </Section>

      <Section title="9. Plans, usage limits & payments">
        <p>
          The Service offers a free tier with usage limits (for example, a
          limited number of AI analyses per day for anonymous visitors and per
          month for free accounts), subject to fair-use. Premium features and
          higher-capability models require a paid subscription.
        </p>
        <p>
          Paid subscriptions are billed through our payment processor, Stripe, on
          a recurring basis (currently $19 per month) and renew automatically
          until cancelled. You can cancel anytime from Settings; cancellation
          takes effect at the end of the current billing period and you retain
          access until then. Except where required by law, payments are
          non-refundable and partial periods are not prorated. Fees are exclusive
          of taxes, which are your responsibility where applicable. We may change
          pricing, plans, limits, or features, and will give reasonable notice of
          material changes that affect an active subscription.
        </p>
      </Section>

      <Section title="10. Our intellectual property">
        <p>
          The Service — including its software, design, scoring methodology,
          text, and the Unicorn Idea Filter and Cash Cow Filter names and logos
          — is owned by us or our licensors and protected by intellectual
          property laws. These Terms grant you a limited, revocable,
          non-transferable license to use the Service for its intended purpose;
          no other rights are granted.
        </p>
      </Section>

      <Section title="11. Third-party services">
        <p>
          The Service relies on third-party providers, including Stripe
          (payments), Anthropic and OpenAI (AI analysis), and Supabase and Vercel
          (hosting and storage). Your use of features that depend on them may
          also be subject to their terms, and we are not responsible for
          third-party services or their acts and omissions.
        </p>
      </Section>

      <Section title="12. Feedback">
        <p>
          If you send us suggestions, ideas, or feedback about the Service, you
          grant us a perpetual, irrevocable, royalty-free license to use it
          without restriction or obligation to you.
        </p>
      </Section>

      <Section title="13. Disclaimers">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as
          available,&rdquo; without warranties of any kind, whether express,
          implied, or statutory, including implied warranties of
          merchantability, fitness for a particular purpose,
          non-infringement, and any warranties arising from course of dealing or
          usage. We do not warrant that the Service will be uninterrupted,
          secure, error-free, or that any analysis or output will be accurate or
          reliable.
        </p>
      </Section>

      <Section title="14. Limitation of liability">
        <p>
          To the fullest extent permitted by law, we and our owners, and our
          suppliers will not be liable for any indirect, incidental, special,
          consequential, exemplary, or punitive damages, or for lost profits,
          revenue, data, goodwill, or business opportunities, arising out of or
          relating to the Service or decisions made using it, even if advised of
          the possibility. Our total aggregate liability for all claims relating
          to the Service will not exceed the greater of the amount you paid us in
          the twelve months before the event giving rise to the claim, or
          US$100. Some jurisdictions do not allow certain limitations, so some of
          the above may not apply to you.
        </p>
      </Section>

      <Section title="15. Indemnification">
        <p>
          You agree to indemnify and hold harmless Innovate Abundance LLC and its
          owners from any claims, damages, liabilities, and reasonable expenses
          (including legal fees) arising out of your Content, your use of the
          Service, or your breach of these Terms or of any law or third-party
          right.
        </p>
      </Section>

      <Section title="16. Termination">
        <p>
          You may stop using the Service at any time. We may suspend or terminate
          your access, with or without notice, if you breach these Terms, if
          required by law, or to protect the Service or other users. Provisions
          that by their nature should survive termination — including ownership,
          disclaimers, limitations of liability, and indemnification — will
          survive. You may request deletion of your data as described in the
          Privacy Policy.
        </p>
      </Section>

      <Section title="17. Governing law & disputes">
        <p>
          These Terms are governed by the laws of the State of Delaware, USA,
          without regard to its conflict-of-laws rules. Before filing a claim,
          you agree to try to resolve it informally by contacting us first. Any
          dispute that cannot be resolved informally will be brought exclusively
          in the state or federal courts located in Delaware, and you consent to
          their jurisdiction and venue. You and we agree that any claim must be
          brought in an individual capacity and not as part of a class action.
        </p>
      </Section>

      <Section title="18. General">
        <p>
          These Terms, together with the Privacy Policy, are the entire agreement
          between you and us regarding the Service. If any provision is found
          unenforceable, the rest remains in effect. Our failure to enforce a
          provision is not a waiver. You may not assign these Terms without our
          consent; we may assign them in connection with a merger, acquisition,
          or sale of assets.
        </p>
      </Section>

      <Section title="19. Changes & contact">
        <p>
          We may update these Terms from time to time. When we do, we will revise
          the date above and, for material changes, provide notice in the app.
          Continuing to use the Service after changes take effect means you
          accept the updated Terms. Questions? Email{" "}
          <a href={`mailto:${CONTACT}`} className="text-teal-700 underline">
            {CONTACT}
          </a>
          .
        </p>
      </Section>

      <p className="mt-8 text-xs text-zinc-400">
        See also our{" "}
        <Link href="/privacy" className="text-teal-700 underline">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
