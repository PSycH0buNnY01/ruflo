#!/usr/bin/env node
/**
 * audit-no-default-export-leak.mjs
 *
 * Scans v3/@claude-flow/cli/src/{commands,mcp-tools,production,ruvector}
 * for any `export default` statement and exits 1 if found.
 *
 * Exception: commands/update.ts is allowed because it has an active
 * default import in __tests__/commands-deep.test.ts.
 *
 * Wire into CI via:
 *   node scripts/audit-no-default-export-leak.mjs
 *
 * Issue: #2141
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

const SCAN_DIRS = [
  'v3/@claude-flow/cli/src/commands',
  'v3/@claude-flow/cli/src/mcp-tools',
  'v3/@claude-flow/cli/src/production',
  'v3/@claude-flow/cli/src/ruvector',
];

/** Files with active default imports that are exempt from this rule. */
const EXEMPT = new Set([
  'v3/@claude-flow/cli/src/commands/update.ts',
]);

function walkDir(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      entries.push(...walkDir(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      entries.push(full);
    }
  }
  return entries;
}

let violations = 0;

for (const dir of SCAN_DIRS) {
  const absDir = join(ROOT, dir);
  let files;
  try {
    files = walkDir(absDir);
  } catch {
    continue;
  }

  for (const file of files) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;

    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^export default\b/.test(lines[i])) {
        console.error(`FAIL  ${rel}:${i + 1}  unexpected \`export default\``);
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} violation(s) found in commands/, mcp-tools/, production/, ruvector/.` +
    '\nRemove the `export default` lines — callers use named imports only.' +
    '\nSee issue #2141 for context.'
  );
  process.exit(1);
} else {
  console.log('OK  no unexpected `export default` in commands/, mcp-tools/, production/, ruvector/');
  process.exit(0);
}
