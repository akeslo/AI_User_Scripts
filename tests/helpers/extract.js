// Small text-slicing helpers used to pull specific functions out of the
// Tampermonkey userscripts (which have no exports/modules) so they can be
// exercised directly in tests, without booting the userscript's DOM/UI code.
//
// These slice on literal marker strings taken from the current script
// source. If a script is refactored enough to move/rename these functions,
// the corresponding test will fail loudly with a "marker not found" error
// (from the assertions below) rather than silently testing stale code.

export function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`extractBlock: start marker not found: ${JSON.stringify(startMarker)}`);
  }
  const end = src.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`extractBlock: end marker not found after start: ${JSON.stringify(endMarker)}`);
  }
  return src.slice(start, end);
}

// Extracts a single statement, from `marker` through the next semicolon.
export function extractStatement(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error(`extractStatement: marker not found: ${JSON.stringify(marker)}`);
  }
  const semi = src.indexOf(';', start);
  if (semi === -1) {
    throw new Error(`extractStatement: no terminating ';' found for marker: ${JSON.stringify(marker)}`);
  }
  return src.slice(start, semi + 1);
}
