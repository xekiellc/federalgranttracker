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
const D1_DATABASE_ID = 'ab74e758-2416-47f4-8dbe-4d44b540444b';
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

// Reads actual row data via Cloudflare's D1 HTTP API directly, instead of
// through `wrangler d1 execute`. Confirmed live (with full raw output
// logged) that `wrangler d1 execute --file --remote --json` never returns
// real row data for a SELECT — it only ever returns a generic per-statement
// execution-stats object ("Total queries executed", "Rows read", etc.),
// for reads and writes alike. That's a real constraint of the CLI in this
// mode, not a parsing bug — two earlier attempts at "fixing the JSON
// extraction" were solving a problem that didn't exist, since there was
// never real data in the output to find. Cloudflare's documented D1 REST
// API (POST .../d1/database/{id}/query) does return real rows, so reads go
// through that instead. Writes still go through wrangler (runD1File above),
// since that's been reliable all along — this only replaces the read path.
async function queryD1(sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`D1 API request failed: ${response.status} ${response.statusText} — ${bodyText.slice(0, 300)}`);
  }

  const json = await response.json();
  if (!json.success) {
    throw new Error(`D1 API returned success:false — ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  }
  return json.result?.[0]?.results ?? [];
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
    rows = await queryD1(selectSql);
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
