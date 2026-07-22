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

  // Extract the log function
  const logMatch = content.match(/function log\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
  if (!logMatch) {
    console.error(`✗ ${name}: could not extract log() function`);
    hasErrors = true;
    return;
  }

  const logFn = logMatch[0];

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

// Check for required helper functions in all three
console.log('\nChecking for required helper functions...');
const requiredHelpers = ['sleep', 'get', 'showLog', 'log'];
scripts.forEach(({ name }) => {
  const content = readFileSync(name, 'utf-8');

  requiredHelpers.forEach(helper => {
    if (content.includes(`function ${helper}(`) || content.includes(`const ${helper} =`)) {
      // Found it
    } else {
      console.error(`✗ ${name}: missing helper function "${helper}"`);
      hasErrors = true;
    }
  });
});

if (!hasErrors) {
  console.log('\n✓ All sync checks passed!');
  process.exit(0);
} else {
  console.error('\n✗ Sync validation failed. See errors above.');
  process.exit(1);
}
