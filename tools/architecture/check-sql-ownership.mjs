#!/usr/bin/env node
// B2 static check (Phase 2 02 §3): SQL written in a module's source may reference only the module's own schema(s) and the
// shared `platform` schema. Complements the runtime guard in @hsp/db (assertModuleOwnsSql), which checks every statement
// a module actually executes. Only string / template literals that look like SQL are inspected, so names such as the
// event type 'jobs.VisitAssigned' are not mistaken for table references.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allSchemas, ownershipFromModulesJson, referencedSchemas } from '../../packages/db/src/query-guard.ts';

const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const LOOKS_LIKE_SQL = /\b(select|insert|update|delete|from|join|into|truncate|alter|create)\b/i;

function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') yield* sourceFiles(full);
    } else if (/\.(ts|mts|js|mjs)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      yield full;
    }
  }
}

export function checkSqlOwnership(root) {
  const spec = JSON.parse(readFileSync(join(root, 'tools/architecture/modules.json'), 'utf8'));
  const ownership = ownershipFromModulesJson(spec);
  const known = allSchemas(ownership);
  const findings = [];
  for (const module of Object.keys(spec.modules)) {
    const allowed = new Set([...(ownership.modules[module] ?? []), ...ownership.shared]);
    for (const file of sourceFiles(join(root, 'packages/modules', module, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(LITERAL)) {
        const literal = match[0].slice(1, -1);
        if (!LOOKS_LIKE_SQL.test(literal)) continue;
        const foreign = [...referencedSchemas(literal, known)].filter((s) => !allowed.has(s));
        if (foreign.length > 0) {
          const line = text.slice(0, match.index).split('\n').length;
          findings.push(`${relative(root, file).replaceAll('\\', '/')}:${line}: module "${module}" SQL references ${foreign.join(', ')}`);
        }
      }
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const findings = checkSqlOwnership(root);
  if (findings.length > 0) {
    console.error(`SQL ownership check (B2) FAILED:\n - ${findings.join('\n - ')}`);
    process.exit(1);
  }
  console.log('SQL ownership check (B2) passed: module SQL references only owned schemas and platform.');
}
