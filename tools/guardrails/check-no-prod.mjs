#!/usr/bin/env node
// No-production guardrail (Phase 2: "No production environment or production credentials").
// Fails if the repository defines a production environment anywhere outside docs/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'coverage', 'docs', '.terraform']);
const SELF = new Set(['tools/guardrails/check-no-prod.mjs', 'tools/guardrails/__tests__/no-prod.test.ts']);
const PROD_DIR = /(^|\/)(prod|production|prd|live)(\/|$)/i;
const CONTENT_RULES = [
  { id: 'app-env-prod', re: /APP_ENV\s*[:=]\s*["']?(prod|production|prd|live)\b/i },
  { id: 'tf-environment-prod', re: /\benvironment\s*=\s*"(prod|production|prd|live)"/i },
  { id: 'gha-environment-prod', re: /^\s*environment\s*:\s*["']?(prod|production|prd|live)["']?\s*$/im },
  { id: 'gha-environment-name-prod', re: /^\s*name\s*:\s*["']?(prod|production)["']?\s*$/im, onlyIn: /^\.github\/workflows\// },
];

function* walk(dir, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (entry.isDirectory()) { yield { rel, dir: true }; yield* walk(full, root); }
    else yield { rel, dir: false, full };
  }
}

export function checkNoProd(root) {
  const findings = [];
  for (const item of walk(root, root)) {
    if (SELF.has(item.rel)) continue;
    if (item.dir) {
      if (PROD_DIR.test(`${item.rel}/`)) findings.push(`${item.rel}/: production-named directory`);
      continue;
    }
    if (PROD_DIR.test(item.rel.replace(/[^/]+$/, ''))) continue; // already reported via directory
    if (/\.(png|jpg|jpeg|gif|ico|lock|svg)$/i.test(item.rel) || statSync(item.full).size > 1_000_000) continue;
    // Tests deliberately use production values to prove the runtime refuses them; they are never deployed.
    if (/(^|\/)__tests__\//.test(item.rel) || /\.test\.ts$/.test(item.rel)) continue;
    const text = readFileSync(item.full, 'utf8');
    for (const rule of CONTENT_RULES) {
      if (rule.onlyIn && !rule.onlyIn.test(item.rel)) continue;
      if (rule.re.test(text)) findings.push(`${item.rel}: ${rule.id}`);
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const findings = checkNoProd(root);
  if (findings.length > 0) {
    console.error(`No-production guardrail FAILED:\n - ${findings.join('\n - ')}`);
    process.exit(1);
  }
  console.log('No-production guardrail passed: no production environment defined outside docs/.');
}
