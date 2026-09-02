#!/usr/bin/env node
// Federal Grant Tracker — funding_opportunity_number enrichment
//
// WHY THIS EXISTS: Tier 1 exact matching (see match-opportunities.cjs) has
// been dormant since it was written — awards.funding_opportunity_number is
// never populated by the main USASpending sync, because that field only
// lives on USASpending's per-award DETAIL endpoint
// (/api/v2/awards/{award_id}/), not the bulk search endpoint the main sync
// uses. Confirmed live against a real award (ASST_NON_UM1AI068614_075):
// the field is `funding_opportunity.number` at the top level of that
// response.
//
// WHY THIS IS ITS OWN SCRIPT, NOT PART OF sync.cjs: fetching this requires
// one HTTP request PER AWARD, not per agency — with ~30,000 awards
// tracked, that's not something to attempt in one run. USASpending's WAF
// already proved (see sync.cjs's own history) that it blocks a run after
// roughly 250 rapid requests. This script deliberately processes a small,
// throttled batch per run and relies on awards.funding_opportunity_checked_at
// to pick up where the last run left off — chipping through the backlog
// over many runs (see its own workflow's schedule) rather than trying to
// finish in one.
//
// An award whose detail response has no funding_opportunity.number (many
// won't — plenty of awarding agencies never report it) still gets
// funding_opportunity_checked_at set, so it isn't re-fetched forever.
// funding_opportunity_number stays NULL in that case — honest, not a
// failure.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const USASPENDING_AWARD_DETAIL_URL = 'https://api.usaspending.gov/api/v2/awards/';
const D1_DATABASE_NAME = 'federalgranttracker';
const BATCH_SIZE = 150; // well under the ~250-request WAF threshold observed in sync.cjs
const REQUEST_DELAY_MS = 500;
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sqlEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runD1File(sqlFilePath) {
  execFileSync(
    'wrangler',
    ['d1', 'execute', D1_DATABASE_NAME, '--remote', '--yes', `--file=${sqlFilePath}`],
    { stdio: 'inherit' }
  );
}

function runD1Query(sql, jsonOutput = false) {
  const tmpFile = path.join(os.tmpdir(), `enrich-query-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    const args = ['d1', 'execute', D1_DATABASE_NAME, '--remote', '--yes', `--file=${tmpFile}`];
    if (jsonOutput) args.push('--json');
    return execFileSync('wrangler', args, { encoding: 'utf-8' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// Fetches one award's detail, with a single retry after backoff on failure.
// Returns { ok: true, number: string|null } on a successful request (number
// may legitimately be null), or { ok: false } if both attempts failed.
async function fetchFundingOpportunityNumber(awardId, attempt = 1) {
  let response;
  try {
    response = await fetch(`${USASPENDING_AWARD_DETAIL_URL}${encodeURIComponent(awardId)}/`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'FederalGrantTracker/1.0 (+https://federalgranttracker.com)',
      },
    });
  } catch (err) {
    response = null;
  }

  if (!response || !response.ok) {
    if (attempt < 2) {
      await sleep(RETRY_DELAY_MS);
      return fetchFundingOpportunityNumber(awardId, attempt + 1);
    }
    return { ok: false };
  }

  try {
    const json = await response.json();
    const number = json?.funding_opportunity?.number || null;
    return { ok: true, number };
  } catch (err) {
    return { ok: false };
  }
}

async function main() {
  // Pull one batch of never-checked awards. award_id here is USASpending's
  // own identifier (e.g. "ASST_NON_UM1AI068614_075"), used directly in the
  // detail endpoint's URL path.
  const selectSql = `
    SELECT id, award_id FROM awards
    WHERE funding_opportunity_checked_at IS NULL
    LIMIT ${BATCH_SIZE};
  `;

  let rows;
  try {
    const rawOutput = runD1Query(selectSql, true);
    const parsed = JSON.parse(rawOutput);
    rows = parsed?.[0]?.results ?? [];
  } catch (err) {
    console.error('Failed to select batch of awards:', err.message);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('No unchecked awards remaining — backlog is fully processed.');
    return;
  }

  console.log(`Checking ${rows.length} awards for funding_opportunity_number...`);

  let foundCount = 0;
  let checkedCount = 0;
  let failedCount = 0;
  const updateStatements = [];

  for (const row of rows) {
    const result = await fetchFundingOpportunityNumber(row.award_id);

    if (!result.ok) {
      failedCount++;
      console.log(`  award ${row.id}: request failed after retry — leaving unchecked, will retry next run.`);
      // Deliberately do NOT set funding_opportunity_checked_at here, so a
      // transient failure gets picked up again on the next run instead of
      // being silently skipped forever.
    } else {
      checkedCount++;
      if (result.number) {
        foundCount++;
        updateStatements.push(
          `UPDATE awards SET funding_opportunity_number = ${sqlEscape(result.number)}, funding_opportunity_checked_at = datetime('now') WHERE id = ${row.id};`
        );
      } else {
        updateStatements.push(
          `UPDATE awards SET funding_opportunity_checked_at = datetime('now') WHERE id = ${row.id};`
        );
      }
    }

    await sleep(REQUEST_DELAY_MS);
  }

  if (updateStatements.length > 0) {
    const tmpFile = path.join(os.tmpdir(), `enrich-updates-${Date.now()}.sql`);
    fs.writeFileSync(tmpFile, updateStatements.join('\n'));
    try {
      runD1File(tmpFile);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }

  console.log(`Checked ${checkedCount} awards (${failedCount} failed, will retry next run). Found funding_opportunity_number on ${foundCount}.`);
}

main();
