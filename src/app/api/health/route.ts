// Reports which AI providers have server-side API keys configured, so the
// Settings UI can show setup status without ever exposing the keys.
export async function GET() {
  return Response.json({
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  });
}
