#!/usr/bin/env node

/**
 * Validate that the duplicated helper functions (sleep, get, showLog, log)
 * are synchronized across all three userscripts.
 *
 * This script checks that:
 * 1. All three files contain the "DUPLICATED HELPERS" comment block
 * 2. The helper function signatures match (accounting for script-specific names like bd- vs gbd-)
 * 3. The XSS-safety invariant (textContent only in log) is maintained in all copies
 *
 * Usage: node validate-helpers-sync.js
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const scripts = [
  { name: 'Claude Bulk Deleter.user.js', prefix: 'bd' },
  { name: 'ChatGPT Bulk Deleter.user.js', prefix: 'bd' },
  { name: 'Gemini Bulk Deleter.user.js', prefix: 'gbd' },
];

let hasErrors = false;

// Returns the full source of `function <name>(...) { ... }` including its body,
// matched by counting braces to the real closing brace. Returns null if absent.
function extractFunctionBody(content, fnName) {
  const header = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
  const m = content.match(header);
  if (!m) return null;

  const start = m.index;
  let depth = 0;
  for (let i = content.indexOf('{', start); i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null; // unbalanced braces — treat as not extractable
}

// Check for DUPLICATED HELPERS comment in all three files
console.log('Checking for DUPLICATED HELPERS marker...');
scripts.forEach(({ name }) => {
  const content = readFileSync(name, 'utf-8');
  if (!content.includes('DUPLICATED HELPERS')) {
    console.error(`✗ ${name}: missing "DUPLICATED HELPERS" marker`);
    hasErrors = true;
  } else {
    console.log(`✓ ${name}: found marker`);
  }
});

// Check for XSS-safety invariant (textContent only, never innerHTML) in log()
console.log('\nChecking XSS-safety invariant in log()...');
scripts.forEach(({ name }) => {
  const content = readFileSync(name, 'utf-8');

  // Extract the log function by brace-counting, NOT by regex. A lazy
  // `\{[\s\S]*?\n\s*\}` stops at the close of the first nested block (the
  // `if (pre) { ... }` inside log()), so everything after it went uninspected
  // and an innerHTML added below that point passed this check clean — while
  // CLAUDE.local.md calls this check the enforcement of the XSS invariant.
  const logFn = extractFunctionBody(content, 'log');
  if (logFn === null) {
    console.error(`✗ ${name}: could not extract log() function`);
    hasErrors = true;
    return;
  }

  if (logFn.includes('innerHTML')) {
    console.error(`✗ ${name}: log() function uses innerHTML (XSS risk!)`);
    hasErrors = true;
  } else if (logFn.includes('textContent')) {
    console.log(`✓ ${name}: log() uses textContent only`);
  } else {
    console.error(`✗ ${name}: log() does not use either innerHTML or textContent`);
    hasErrors = true;
  }
});

// Check for required helper functions in all three, and that their signatures agree.
// Presence alone is not enough: a divergence in the parameter list of a hand-mirrored
// helper is exactly the drift this check exists to catch, and the README documents
// this as a signature comparison.
console.log('\nChecking for required helper functions...');
const requiredHelpers = ['sleep', 'get', 'showLog', 'log'];

// Returns the normalized parameter list of `helper` in `content`, or null if absent.
// Handles both `function name(args)` and `const name = (args) =>` / `const name = arg =>`.
function extractSignature(content, helper) {
  const fnDecl = content.match(
    new RegExp(`function\\s+${helper}\\s*\\(([^)]*)\\)`)
  );
  if (fnDecl) return normalizeParams(fnDecl[1]);

  const arrow = content.match(
    new RegExp(`const\\s+${helper}\\s*=\\s*(?:\\(([^)]*)\\)|([A-Za-z_$][\\w$]*))\\s*=>`)
  );
  if (arrow) return normalizeParams(arrow[1] !== undefined ? arrow[1] : arrow[2]);

  return null;
}

function normalizeParams(params) {
  return (params || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .join(', ');
}

const signatures = new Map(); // helper -> [{ name, signature }]

scripts.forEach(({ name }) => {
  const content = readFileSync(name, 'utf-8');

  requiredHelpers.forEach(helper => {
    const signature = extractSignature(content, helper);
    if (signature === null) {
      console.error(`✗ ${name}: missing helper function "${helper}"`);
      hasErrors = true;
      return;
    }
    if (!signatures.has(helper)) signatures.set(helper, []);
    signatures.get(helper).push({ name, signature });
  });
});

console.log('\nChecking helper signatures match across copies...');
requiredHelpers.forEach(helper => {
  const found = signatures.get(helper) || [];
  if (found.length < scripts.length) return; // missing copies already reported above

  const distinct = [...new Set(found.map(f => f.signature))];
  if (distinct.length > 1) {
    console.error(`✗ ${helper}(): signatures diverge across copies:`);
    found.forEach(f => console.error(`    ${f.name}: ${helper}(${f.signature})`));
    hasErrors = true;
  } else {
    console.log(`✓ ${helper}(${distinct[0]}): identical in all ${found.length} copies`);
  }
});

if (!hasErrors) {
  console.log('\n✓ All sync checks passed!');
  process.exit(0);
} else {
  console.error('\n✗ Sync validation failed. See errors above.');
  process.exit(1);
}
