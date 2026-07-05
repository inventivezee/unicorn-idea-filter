#!/usr/bin/env node
// Migration runner — applies supabase/migrations/*.sql to the remote Supabase
// database over the Management API (POST /v1/projects/{ref}/database/query),
// so schema changes no longer need copy-pasting into the SQL editor.
//
// It needs ONE secret, a Supabase Personal Access Token (SUPABASE_ACCESS_TOKEN,
// prefix "sbp_"), created at https://supabase.com/dashboard/account/tokens and
// kept in .env.local (gitignored). The project ref is read from
// SUPABASE_PROJECT_REF or parsed from NEXT_PUBLIC_SUPABASE_URL. This token is a
// LOCAL developer tool — it is never deployed and is not a Vercel env var.
//
// Applied migrations are recorded in supabase_migrations.schema_migrations (the
// same table the Supabase CLI uses), so this runner and `supabase db push` stay
// interoperable and nothing is applied twice.
//
// Commands:
//   node scripts/migrate.mjs status              show local vs applied
//   node scripts/migrate.mjs up                  apply every unapplied migration
//   node scripts/migrate.mjs baseline <version>  mark files <= version as applied
//                                                WITHOUT running them (adopt an
//                                                existing DB that was migrated by
//                                                hand — e.g. `baseline 007`)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const FILE_RE = /^([0-9]+)_(.*)\.sql$/; // matches the Supabase CLI's own pattern

// --- env: .env.local (if present) then real process.env (CI) --------------
function loadEnv() {
  const env = { ...process.env };
  const file = join(ROOT, ".env.local");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) env[key] = val; // real env wins
    }
  }
  return env;
}

function resolveConfig(env) {
  const token = env.SUPABASE_ACCESS_TOKEN?.trim();
  let ref = env.SUPABASE_PROJECT_REF?.trim();
  if (!ref && env.NEXT_PUBLIC_SUPABASE_URL) {
    const m = /^https?:\/\/([a-z0-9]+)\./i.exec(
      env.NEXT_PUBLIC_SUPABASE_URL.trim(),
    );
    if (m) ref = m[1];
  }
  const missing = [];
  if (!token) missing.push("SUPABASE_ACCESS_TOKEN (a Personal Access Token, sbp_…)");
  if (!ref)
    missing.push(
      "SUPABASE_PROJECT_REF (or a valid NEXT_PUBLIC_SUPABASE_URL to derive it from)",
    );
  if (missing.length) {
    console.error(
      `Missing configuration in .env.local:\n  - ${missing.join("\n  - ")}\n\n` +
        `Create a token at https://supabase.com/dashboard/account/tokens and add:\n` +
        `  SUPABASE_ACCESS_TOKEN=sbp_xxx\n`,
    );
    process.exit(1);
  }
  if (!token.startsWith("sbp_")) {
    console.warn(
      "Warning: SUPABASE_ACCESS_TOKEN doesn't start with 'sbp_' — is it a Personal Access Token?",
    );
  }
  return { token, ref };
}

// --- Management API: run arbitrary SQL -------------------------------------
async function runSql(cfg, query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${cfg.ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }), // no read_only → writable, DDL allowed
    },
  );
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const body = JSON.parse(text);
      message = body.message || body.error || text;
    } catch {
      // non-JSON error body
    }
    throw new Error(`Supabase API ${res.status}: ${message}`);
  }
  try {
    return JSON.parse(text); // array of row objects; [] for DDL
  } catch {
    return [];
  }
}

/**
 * Guard against pointing at the wrong Supabase project: a PAT can reach every
 * project the account owns, so the ref is the ONLY thing selecting the
 * target. Before any write, confirm the database actually contains this
 * app's schema (public.ideas, created by migration 001). Read-only.
 */
async function preflight(cfg) {
  const rows = await runSql(
    cfg,
    "select current_database() as db, to_regclass('public.ideas') as ideas, to_regclass('public.profiles') as profiles;",
  );
  const r = rows[0] ?? {};
  console.log(`Target project ref: ${cfg.ref}`);
  console.log(
    `  database=${r.db ?? "?"}  ideas=${r.ideas ?? "MISSING"}  profiles=${r.profiles ?? "MISSING"}`,
  );
  if (!r.ideas) {
    if (process.env.MIGRATE_ALLOW_EMPTY === "1") {
      console.warn(
        "  public.ideas not found — proceeding anyway (MIGRATE_ALLOW_EMPTY=1).",
      );
      return;
    }
    console.error(
      `
Abort: this database has no public.ideas table, so it does not look
` +
        `like the Unicorn Idea Filter database. Check SUPABASE_PROJECT_REF in
` +
        `.env.local. (Bootstrapping a brand-new empty project instead? Re-run
` +
        `with MIGRATE_ALLOW_EMPTY=1.)`,
    );
    process.exit(1);
  }
}

function localMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`No migrations directory at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return readdirSync(MIGRATIONS_DIR)
    .map((file) => {
      const m = FILE_RE.exec(file);
      if (!m) return null;
      return {
        version: m[1],
        name: m[2],
        file,
        sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

const TRACKING_DDL = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key
);
alter table supabase_migrations.schema_migrations add column if not exists name text;
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
`;

async function appliedVersions(cfg) {
  await runSql(cfg, TRACKING_DDL);
  const rows = await runSql(
    cfg,
    "select version from supabase_migrations.schema_migrations order by version;",
  );
  return new Set(rows.map((r) => String(r.version)));
}

/** Escape a JS string for a single-quoted SQL literal. */
function sqlLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function cmdStatus(cfg) {
  const local = localMigrations();
  await preflight(cfg);
  const applied = await appliedVersions(cfg);
  console.log("");
  console.log("  version  status    name");
  console.log("  -------  --------  ----");
  for (const mig of local) {
    const state = applied.has(mig.version) ? "applied" : "PENDING";
    console.log(`  ${mig.version.padEnd(7)}  ${state.padEnd(8)}  ${mig.name}`);
  }
  const pending = local.filter((m) => !applied.has(m.version));
  console.log(
    `\n${pending.length} pending, ${local.length - pending.length} applied.`,
  );
  // Flag applied versions that no longer have a local file (informational).
  const localVersions = new Set(local.map((m) => m.version));
  const orphans = [...applied].filter((v) => !localVersions.has(v));
  if (orphans.length) {
    console.log(`Recorded but no local file: ${orphans.join(", ")}`);
  }
}

async function cmdUp(cfg) {
  const local = localMigrations();
  await preflight(cfg);
  const applied = await appliedVersions(cfg);
  const pending = local.filter((m) => !applied.has(m.version));
  if (!pending.length) {
    console.log("Everything is up to date — nothing to apply.");
    return;
  }
  console.log(`Applying ${pending.length} migration(s) to ${cfg.ref}…\n`);
  for (const mig of pending) {
    process.stdout.write(`  ${mig.version} ${mig.name} … `);
    // migration + tracking insert in one query string → atomic (all-or-nothing
    // under Postgres' simple-query protocol; the explicit txn makes it certain).
    const wrapped = `
begin;
${mig.sql}
;
insert into supabase_migrations.schema_migrations (version, name)
  values (${sqlLiteral(mig.version)}, ${sqlLiteral(mig.name)})
  on conflict (version) do nothing;
commit;
`;
    try {
      await runSql(cfg, wrapped);
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(`\n${err.message}\n`);
      console.error(
        `Stopped at ${mig.file}. It was rolled back; earlier migrations stay applied. Fix the SQL and re-run.`,
      );
      process.exit(1);
    }
  }
  console.log("\nDone.");
}

async function cmdBaseline(cfg, upTo) {
  if (!upTo) {
    console.error(
      "Usage: node scripts/migrate.mjs baseline <version>\n" +
        "  Marks every local migration whose version is <= <version> as applied\n" +
        "  WITHOUT running it — for adopting a DB already migrated by hand.",
    );
    process.exit(1);
  }
  const local = localMigrations();
  await preflight(cfg);
  const applied = await appliedVersions(cfg);
  const toMark = local.filter(
    (m) =>
      !applied.has(m.version) &&
      m.version.localeCompare(upTo, undefined, { numeric: true }) <= 0,
  );
  if (!toMark.length) {
    console.log(`Nothing to baseline at or below ${upTo}.`);
    return;
  }
  const values = toMark
    .map((m) => `(${sqlLiteral(m.version)}, ${sqlLiteral(m.name)})`)
    .join(", ");
  await runSql(
    cfg,
    `insert into supabase_migrations.schema_migrations (version, name)
       values ${values}
       on conflict (version) do nothing;`,
  );
  console.log(
    `Baselined ${toMark.length} migration(s) as applied (not run): ${toMark
      .map((m) => m.version)
      .join(", ")}`,
  );
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = resolveConfig(loadEnv());
  switch (cmd) {
    case "status":
      await cmdStatus(cfg);
      break;
    case "up":
      await cmdUp(cfg);
      break;
    case "baseline":
      await cmdBaseline(cfg, arg);
      break;
    case "sql": {
      if (!arg) {
        console.error('Usage: node scripts/migrate.mjs sql "select ...;"');
        process.exit(1);
      }
      const rows = await runSql(cfg, arg);
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    default:
      console.error(
        "Usage: node scripts/migrate.mjs <status|up|baseline|sql>\n" +
          "  status              show which migrations are applied vs pending\n" +
          "  up                  apply all pending migrations\n" +
          "  baseline <version>  record files <= version as applied without running\n" +
          '  sql "<query>"       run an ad-hoc SQL query and print rows as JSON',
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
