// Transactional email via Resend's REST API (no SDK dependency). Used for
// events that finish while nobody is watching — above all the 20-40 minute
// filter-design chain. Sending is always best-effort: a mail failure must
// never fail the operation that triggered it.
//
// Env:
//   RESEND_API_KEY  required to send; absent = emails silently skipped
//   EMAIL_FROM      verified sender, e.g. 'Unicorn Idea Filter <hello@yourdomain.com>'
//                   (falls back to Resend's onboarding sender, which only
//                   delivers to the Resend account owner — fine for testing,
//                   set a verified domain for real users)
//   NEXT_PUBLIC_APP_URL  used for links back into the app

const FALLBACK_FROM = "Unicorn Idea Filter <onboarding@resend.dev>";

function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shared shell so every mail looks consistent. Body is trusted HTML. */
function layout(title: string, bodyHtml: string, ctaHref: string, ctaLabel: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px 16px;color:#27272a">
  <p style="font-size:13px;color:#0d9488;font-weight:600;margin:0 0 16px">Unicorn Idea Filter</p>
  <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
  ${bodyHtml}
  <p style="margin:20px 0">
    <a href="${ctaHref}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600">${escapeHtml(ctaLabel)}</a>
  </p>
  <p style="font-size:12px;color:#a1a1aa;margin:24px 0 0">You're receiving this because a task you started in Unicorn Idea Filter finished.</p>
</div>`;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return; // email not configured — feature degrades silently
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || FALLBACK_FROM,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      console.error("email send failed", res.status, await res.text());
    }
  } catch (err) {
    console.error(
      "email send failed",
      err instanceof Error ? err.message : err,
    );
  }
}

/** "Your custom filter is ready" — the design chain reached `ready`. */
export function designReadyEmail(filterName: string): {
  subject: string;
  html: string;
} {
  return {
    subject: `Your custom filter “${filterName}” is ready`,
    html: layout(
      `“${filterName}” is ready to review`,
      `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">The three-model design chain has finished: ChatGPT&nbsp;5.5&nbsp;Pro designed your instrument, Claude&nbsp;Fable&nbsp;5 reviewed it at max effort, and ChatGPT&nbsp;5.5&nbsp;Pro produced the final version.</p>
       <p style="font-size:14px;line-height:1.6;margin:0">Open it to review the gates and criteria, then accept it or regenerate.</p>`,
      appUrl("/filters"),
      "Review your filter",
    ),
  };
}

/** The design chain failed — invite a retry. */
export function designFailedEmail(reason: string): {
  subject: string;
  html: string;
} {
  return {
    subject: "Your filter design needs another try",
    html: layout(
      "The filter design didn't finish",
      `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">Something went wrong while designing your custom filter:</p>
       <p style="font-size:13px;line-height:1.5;margin:0;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#b91c1c">${escapeHtml(reason)}</p>
       <p style="font-size:14px;line-height:1.6;margin:12px 0 0">Your goals are saved — one click starts a fresh run.</p>`,
      appUrl("/filters"),
      "Try again",
    ),
  };
}
