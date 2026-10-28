/**
 * Converts solidity-coverage's Istanbul `coverage-final.json` into the standard
 * `coverage-summary.json` shape consumed by the research-results API.
 *
 * solidity-coverage writes the final map and an HTML/LCOV report, but not the JSON
 * summary. The dashboard must not hardcode coverage percentages, so this script derives
 * them from the measured statement/branch/function counters.
 *
 * Usage: node scripts/coverage-summary.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const INPUT = resolve("coverage/coverage-final.json");
const OUTPUT = resolve("coverage/coverage-summary.json");

if (!existsSync(INPUT)) {
  console.error(`Missing ${INPUT}. Run \`npx hardhat coverage\` first.`);
  process.exit(1);
}

const final = JSON.parse(readFileSync(INPUT, "utf8"));
const summary = {};

const total = {
  statements: { total: 0, covered: 0, skipped: 0, pct: 0 },
  branches: { total: 0, covered: 0, skipped: 0, pct: 0 },
  functions: { total: 0, covered: 0, skipped: 0, pct: 0 },
  lines: { total: 0, covered: 0, skipped: 0, pct: 0 },
};

function percent(covered, count) {
  // Istanbul reports 100% for an empty file (nothing to miss).
  return count === 0 ? 100 : Number(((covered / count) * 100).toFixed(2));
}

for (const [file, data] of Object.entries(final)) {
  const statements = data.s ?? {};
  const statementTotal = Object.keys(statements).length;
  const statementCovered = Object.values(statements).filter((n) => n > 0).length;

  const branchMap = data.branchMap ?? {};
  const branchCounts = data.b ?? {};
  let branchTotal = 0;
  let branchCovered = 0;
  for (const [id, entry] of Object.entries(branchMap)) {
    const counts = branchCounts[id] ?? [];
    const locations = entry.locations ?? [];
    for (let i = 0; i < locations.length; i += 1) {
      branchTotal += 1;
      if ((counts[i] ?? 0) > 0) branchCovered += 1;
    }
  }

  const functions = data.f ?? {};
  const functionTotal = Object.keys(functions).length;
  const functionCovered = Object.values(functions).filter((n) => n > 0).length;

  // solidity-coverage already records the Istanbul line map. Use it directly rather
  // than re-deriving lines from statement starts: the two are not identical when a
  // source line contains several statements with different execution counts.
  const lineCounts = data.l ?? {};
  const lineTotal = Object.keys(lineCounts).length;
  const lineCovered = Object.values(lineCounts).filter((n) => n > 0).length;

  summary[file] = {
    statements: {
      total: statementTotal,
      covered: statementCovered,
      skipped: 0,
      pct: percent(statementCovered, statementTotal),
    },
    branches: {
      total: branchTotal,
      covered: branchCovered,
      skipped: 0,
      pct: percent(branchCovered, branchTotal),
    },
    functions: {
      total: functionTotal,
      covered: functionCovered,
      skipped: 0,
      pct: percent(functionCovered, functionTotal),
    },
    lines: {
      total: lineTotal,
      covered: lineCovered,
      skipped: 0,
      pct: percent(lineCovered, lineTotal),
    },
  };

  for (const metric of ["statements", "branches", "functions", "lines"]) {
    total[metric].total += summary[file][metric].total;
    total[metric].covered += summary[file][metric].covered;
  }
}

for (const metric of ["statements", "branches", "functions", "lines"]) {
  total[metric].pct = percent(total[metric].covered, total[metric].total);
}
summary.total = total;

writeFileSync(OUTPUT, JSON.stringify(summary, null, 2));

console.log(`Wrote ${OUTPUT}`);
console.log(
  `Statements ${total.statements.pct}% (${total.statements.covered}/${total.statements.total}), ` +
    `branches ${total.branches.pct}% (${total.branches.covered}/${total.branches.total}), ` +
    `functions ${total.functions.pct}% (${total.functions.covered}/${total.functions.total}), ` +
    `lines ${total.lines.pct}% (${total.lines.covered}/${total.lines.total})`
);
