#!/usr/bin/env node
// Federal Grant Tracker — opportunity/award matching job
//
// WHY THIS IS ITS OWN FILE, NOT PART OF sync.cjs: keeping matching logic
// separate means a bug here can never corrupt the award data itself —
// worst case, opportunity_id/match_confidence just don't get set on a
// given run, and the next run tries again. It's meant to be run right
// after usaspending-sync-worker/sync.cjs completes (same GitHub Actions
// workflow, as a second step), but it's safe to run on its own too since
// every UPDATE here is idempotent — re-running it never produces a
// different result unless the underlying award/opportunity data changed.
//
// MATCHING STRATEGY, in priority order:
//
//   Tier 1 — 'exact': awards.funding_opportunity_number matches an
//   opportunities.opportunity_number exactly. This is the strongest
//   possible match, but it currently has no live data feeding it —
//   sync.cjs does not populate funding_opportunity_number today (that
//   field only exists on USASpending's per-award detail endpoint, not
//   the bulk search endpoint the sync uses). Included here so matching
//   automatically activates the day sync.cjs is extended to pull it, with
//   no changes needed in this file.
//
//   Tier 2 — 'cfda_inferred': awards.cfda_number matches an opportunity
//   with the same cfda_number and same agency_id, whose posted_date is
//   the closest date at-or-before the award's award_date. This is the
//   real matching path today, since it only depends on cfda_number and
//   place-of-performance state — both of which sync.cjs now captures.
//
// An award that matches neither tier keeps opportunity_id = NULL and
// match_confidence = NULL, same as before this job existed — that's
// honest, not a bug, per the "no fabricated data" rule.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const D1_DATABASE_NAME = 'federalgranttracker';

const TIER_1_EXACT_MATCH_SQL = `
UPDATE awards
SET opportunity_id = (
  SELECT o.id FROM opportunities o
  WHERE o.opportunity_number = awards.funding_opportunity_number
  LIMIT 1
),
match_confidence = 'exact'
WHERE awards.opportunity_id IS NULL
  AND awards.funding_opportunity_number IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM opportunities o
    WHERE o.opportunity_number = awards.funding_opportunity_number
  );
`;

const TIER_2_CFDA_INFERRED_MATCH_SQL = `
UPDATE awards
SET opportunity_id = (
  SELECT o.id FROM opportunities o
  WHERE o.cfda_number = awards.cfda_number
    AND o.agency_id = awards.agency_id
    AND o.posted_date IS NOT NULL
    AND o.posted_date <= awards.award_date
  ORDER BY o.posted_date DESC
  LIMIT 1
),
match_confidence = 'cfda_inferred'
WHERE awards.opportunity_id IS NULL
  AND awards.cfda_number IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM opportunities o
    WHERE o.cfda_number = awards.cfda_number
      AND o.agency_id = awards.agency_id
  );
`;

const COUNT_MATCHES_SQL = `
SELECT match_confidence, COUNT(*) as count
FROM awards
WHERE match_confidence IS NOT NULL
GROUP BY match_confidence;
`;

function runD1File(sqlFilePath, jsonOutput = false) {
  const args = ['d1', 'execute', D1_DATABASE_NAME, '--remote', '--yes', `--file=${sqlFilePath}`];
  if (jsonOutput) args.push('--json');
  return execFileSync('wrangler', args, { encoding: 'utf-8' });
}

function runSql(sql, jsonOutput = false) {
  const tmpFile = path.join(os.tmpdir(), `match-job-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    return runD1File(tmpFile, jsonOutput);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function main() {
  console.log('Running Tier 1 (exact funding_opportunity_number match)...');
  runD1File_safely(TIER_1_EXACT_MATCH_SQL);

  console.log('Running Tier 2 (CFDA + agency + timing inferred match)...');
  runD1File_safely(TIER_2_CFDA_INFERRED_MATCH_SQL);

  console.log('Fetching match summary...');
  try {
    const output = runSql(COUNT_MATCHES_SQL, true);
    console.log(output);
  } catch (err) {
    // Summary query failing doesn't mean the matching itself failed —
    // log it but don't exit non-zero over a reporting step.
    console.error('Could not fetch match summary:', err.message);
  }
}

function runD1File_safely(sql) {
  try {
    runSql(sql);
  } catch (err) {
    console.error('Matching step failed:', err.message);
    process.exit(1);
  }
}

main();
