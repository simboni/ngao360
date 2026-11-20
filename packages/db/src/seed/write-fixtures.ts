/* eslint-disable no-console -- CLI script output */
/**
 * Regenerate the SYNTHETIC registry-import fixtures under fixtures/registry/.
 *
 *   pnpm --filter @ngao360/db exec tsx src/seed/write-fixtures.ts          # write
 *   pnpm --filter @ngao360/db exec tsx src/seed/write-fixtures.ts --check  # verify unchanged
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rowsToCsv, syntheticBungomaAmendmentRows, syntheticBungomaRows } from './synthetic-bungoma';

const ROOT = resolve(__dirname, '../../../../fixtures/registry');

/** Deliberately broken rows that exercise the import validation report. */
function invalidSampleCsv(): string {
  const good = syntheticBungomaRows().slice(0, 3);
  const text = rowsToCsv(good).trimEnd().split('\n');
  text.push(
    // Unknown county code
    '048,Atlantis,SYN-C01,Synthetic Constituency North,SYN-C01-W01,North Ward 1 (synthetic),SYN-C01-W01-P01,Synthetic Primary School C111,SYN-BAD-001,Bad county row,400,1,,,SYNTHETIC (no real location)',
    // County name does not match code 039
    '039,Busia,SYN-C01,Synthetic Constituency North,SYN-C01-W01,North Ward 1 (synthetic),SYN-C01-W01-P01,Synthetic Primary School C111,SYN-BAD-002,Wrong county name,400,1,,,SYNTHETIC (no real location)',
    // Duplicate station code (first data row)
    `${text[1]}`,
    // Non-numeric registered voters
    '039,Bungoma,SYN-C01,Synthetic Constituency North,SYN-C01-W01,North Ward 1 (synthetic),SYN-C01-W01-P01,Synthetic Primary School C111,SYN-BAD-003,Bad voters,many,1,,,SYNTHETIC (no real location)',
    // Ward assigned to a different constituency than earlier rows
    '039,Bungoma,SYN-C02,Synthetic Constituency South,SYN-C01-W01,North Ward 1 (synthetic),SYN-C01-W01-P01,Synthetic Primary School C111,SYN-BAD-004,Inconsistent parent,400,1,,,SYNTHETIC (no real location)',
    // Missing registered voters (warning only; stays empty)
    '039,Bungoma,SYN-C01,Synthetic Constituency North,SYN-C01-W01,North Ward 1 (synthetic),SYN-C01-W01-P01,Synthetic Primary School C111,SYN-OK-005,No voter figure,,1,,,SYNTHETIC (no real location)',
  );
  return text.join('\n') + '\n';
}

const files: Record<string, string> = {
  'bungoma-synthetic-2027-r1.csv': rowsToCsv(syntheticBungomaRows()),
  'bungoma-synthetic-2027-r2-amendment.csv': rowsToCsv(syntheticBungomaAmendmentRows()),
  'bungoma-synthetic-invalid-sample.csv': invalidSampleCsv(),
};

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, content] of Object.entries(files)) {
  const path = resolve(ROOT, name);
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== content) {
      console.error(`stale: ${name}`);
      stale++;
    }
  } else {
    writeFileSync(path, content);
    console.log(`wrote ${name}`);
  }
}
if (stale > 0) process.exitCode = 1;
