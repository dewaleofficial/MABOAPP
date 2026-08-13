#!/usr/bin/env node
/**
 * CLAUDE.md §3.7 — RLS on every table, deny by default.
 *
 * Scans infra/migrations for CREATE TABLE statements and fails the build if a
 * table is created without a matching ENABLE ROW LEVEL SECURITY and at least
 * one CREATE POLICY.
 *
 * This is the cheapest possible defence against the single most common
 * Supabase breach pattern. Do not weaken it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'infra/migrations';

let sql = '';
try {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    sql += readFileSync(join(DIR, f), 'utf8') + '\n';
  }
} catch {
  console.log('No migrations yet — nothing to check.');
  process.exit(0);
}

const stripped = sql.replace(/--.*$/gm, '');

const created = [
  ...stripped.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?(\w+)["']?/gi),
].map((m) => m[1].toLowerCase());

const rlsEnabled = new Set(
  [...stripped.matchAll(/alter\s+table\s+(?:public\.)?["']?(\w+)["']?\s+enable\s+row\s+level\s+security/gi)]
    .map((m) => m[1].toLowerCase()),
);

const hasPolicy = new Set(
  [...stripped.matchAll(/create\s+policy\s+[^\n]*?\s+on\s+(?:public\.)?["']?(\w+)["']?/gi)]
    .map((m) => m[1].toLowerCase()),
);

const failures = [];
for (const t of new Set(created)) {
  if (!rlsEnabled.has(t)) failures.push(`${t}: RLS is not enabled`);
  else if (!hasPolicy.has(t)) failures.push(`${t}: RLS enabled but no policy defined (deny-all is not a policy)`);
}

if (failures.length) {
  console.error('\n✗ RLS guard failed — see CLAUDE.md §3.7 and §9\n');
  for (const f of failures) console.error(`  · ${f}`);
  console.error('\nA table without a policy is a public API endpoint.\n');
  process.exit(1);
}

console.log(`✓ RLS guard passed — ${new Set(created).size} table(s) checked`);
