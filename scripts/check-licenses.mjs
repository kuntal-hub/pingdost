#!/usr/bin/env node
/**
 * License report for every npm dependency (production and dev), checked against the project
 * rule: permissive or OSI licenses compatible with AGPL-3.0-or-later (ARCHITECTURE A10,
 * ADR 0001). Rust crates are checked by `cargo deny check licenses` (deny.toml).
 *
 *   node scripts/check-licenses.mjs            # check; exit 1 on a problem
 *   node scripts/check-licenses.mjs --report   # also print the summary table (Markdown)
 */
import { execSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Zlib',
  'BlueOak-1.0.0',
  'MPL-2.0',
  'Python-2.0',
  // The app's fonts (ADR 0035): OSI approved, and the fonts ship unmodified with their names.
  'OFL-1.1',
]);

/** Packages allowed despite their license, with the reason (docs/security/audits.md). */
const EXCEPTIONS = new Map([
  ['caniuse-lite', 'CC-BY-4.0 browser-support data, used by build tools only; not shipped code'],
]);

/** True when an SPDX expression is satisfied by the allow list (OR: any branch; AND: all). */
function allowed(expression) {
  const text = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (/\sOR\s/.test(text)) return text.split(/\s+OR\s+/).some(allowed);
  if (/\sAND\s/.test(text)) return text.split(/\s+AND\s+/).every(allowed);
  return ALLOWED.has(text);
}

// A fixed command line (no user input); through the shell so `pnpm.cmd` resolves on Windows.
const output = execSync('pnpm licenses list --json', {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
/** @type {Record<string, { name: string; versions: string[] }[]>} */
const byLicense = JSON.parse(output);

const problems = [];
const rows = [];
for (const [license, packages] of Object.entries(byLicense)) {
  rows.push([license, packages.length]);
  if (allowed(license)) continue;
  for (const pkg of packages) {
    if (EXCEPTIONS.has(pkg.name)) continue;
    problems.push(`${pkg.name}@${pkg.versions.join(',')}: ${license}`);
  }
}

if (process.argv.includes('--report')) {
  console.log('| License | Packages |\n|---|---|');
  for (const [license, count] of rows.sort((a, b) => b[1] - a[1])) {
    console.log(`| ${license} | ${count} |`);
  }
  for (const [name, reason] of EXCEPTIONS) console.log(`\nException: ${name} — ${reason}`);
}

if (problems.length > 0) {
  console.error(`Licenses outside the allow list:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const total = rows.reduce((sum, [, count]) => sum + count, 0);
console.log(`licenses ok: ${total} packages, ${rows.length} license expressions`);
