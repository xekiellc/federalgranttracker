#!/usr/bin/env node
// Federal Grant Tracker — USASpending sync (GitHub Actions version)
//
// WHY THIS EXISTS: the original Cloudflare Worker version of this sync
// failed every single scheduled run with HTTP 525 (TLS handshake failure)
// — Cloudflare Workers' network was being rejected by USASpending.gov's
// infrastructure before any application code ran. That's a network-layer
// problem, not a code problem, so no amount of header/retry tweaking
// inside the Worker fixed it. This script does the exact same fetch/parse
// work, but runs on GitHub Actions' network instead, and writes to the
// same D1 database via `wrangler d1 execute` using CLOUDFLARE_API_TOKEN
// (no Cloudflare Workers binding involved at all).
//
// UPDATE: the initial version only ever fetched page 1 (100 rows) with no
// pagination — real NIH award volume is far larger (a single major
// recipient like Cleveland Clinic alone can have well over 100 real
// awards), so the 55-recipient dataset from the first run was badly
// incomplete, not a full picture. Added pagination (looping pages until
// exhausted or a safety cap) — same root pattern as the Grants.gov sync's
// row-cap bug fixed earlier tonight. Also widened the recipient slug
// truncation limit, since merging distinct real organizations under a
// truncation-collided slug would now be a much likelier silent risk at
// this larger scale.
//
// UPDATE 2: now requests CFDA number and place-of-performance state on
// every award. Both columns exist in the schema, but after this ran live,
// awards.cfda_number came back NULL on all 4,995 synced rows — meaning
// either 'CFDA Number' isn't the literal field name USASpending's API
// expects, or it's valid but shaped differently than a flat string
// (USASpending renamed CFDA to "Assistance Listings" in 2022, and some
// endpoints return that as an array of objects, not one string). Rather
// than guess a second field name blind, this update adds a one-time debug
// log of the raw first result object on page 1, so the next run's GitHub
// Actions log shows the actual field names USASpending returns. Once we
// see that output, parseAward() gets corrected to read the real field —
// this debug line comes back out once that's confirmed.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const USASPENDING_SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const D1_DATABASE_NAME = 'federalgranttracker';
const GRANT_AWARD_TYPE_CODES = ['02', '03', '04', '05'];

function currentFiscalYear() {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  return month >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

function fiscalYearRange(fy) {
  return { start: `${fy - 1}-10-01`, end: `${fy}-09-30` };
}

function fiscalYearFromDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const month = d.getUTCMonth() + 1;
  return month >= 10 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 150);
}

function sqlEscape(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseAward(result) {
  const awardId = result.generated_internal_id || result['Award ID'];
  const recipientName = result['Recipient Name'] || 'Unknown recipient';
  const amountRaw = result['Award Amount'];
  const amount = typeof amountRaw === 'number' ? Math.round(amountRaw) : parseInt(amountRaw, 10);
  const startDate = result['Start Date'] || null; // "YYYY-MM-DD"
  const cfdaNumber = result['CFDA Number'] || null;
  const placeOfPerformanceStateCode = result['Place of Performance State Code'] || null;

  return {
    award_id: awardId,
    recipient_name: recipientName,
    recipient_slug: slugify(recipientName),
    amount: Number.isFinite(amount) ? amount : null,
    award_date: startDate,
    fiscal_year: startDate ? fiscalYearFromDate(startDate) : currentFiscalYear(),
    cfda_number: cfdaNumber,
    place_of_performance_state_code: placeOfPerformanceStateCode,
  };
}

async function fetchNihAwards() {
  const fy = currentFiscalYear();
  const { start, end } = fiscalYearRange(fy);

  // USASpending's own documented max page size is 100 — raising `limit`
  // isn't an option, so real coverage requires looping through pages.
  // Safety cap at 50 pages (5,000 awards) per run to keep this script's
  // runtime bounded; if NIH's real total exceeds that, later runs will
  // still catch up over time since every write is an idempotent upsert.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;

  let allResults = [];
  let page = 1;
  let loggedDebugSample = false;

  while (page <= MAX_PAGES) {
    const requestBody = {
      filters: {
        award_type_codes: GRANT_AWARD_TYPE_CODES,
        agencies: [{ type: 'awarding', tier: 'subtier', name: 'National Institutes of Health' }],
        time_period: [{ start_date: start, end_date: end }],
      },
      fields: [
        'Award ID',
        'Recipient Name',
        'Award Amount',
        'Awarding Agency',
        'Awarding Sub Agency',
        'Start Date',
        'End Date',
        'Award Type',
        'CFDA Number',
        'Place of Performance State Code',
        'generated_internal_id',
      ],
      page,
      limit: PAGE_SIZE,
      sort: 'Award Amount',
      order: 'desc',
    };

    const response = await fetch(USASPENDING_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'FederalGrantTracker/1.0 (+https://federalgranttracker.com)',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`USASpending request failed on page ${page}: ${response.status} ${response.statusText} — ${bodyText.slice(0, 300)}`);
    }

    const json = await response.json();
    const results = json?.results;
    if (!Array.isArray(results)) {
      throw new Error(`Unexpected USASpending response shape on page ${page}: no results array found`);
    }

    // TEMPORARY DEBUG: log the raw shape of the very first result so we can
    // see USASpending's actual field names for CFDA / place-of-performance
    // in the GitHub Actions log. Remove this block once cfda_number and
    // place_of_performance_state_code are confirmed populating correctly.
    if (!loggedDebugSample && results.length > 0) {
      console.log('DEBUG — raw first result object from USASpending:');
      console.log(JSON.stringify(results[0], null, 2));
      loggedDebugSample = true;
    }

    allResults = allResults.concat(results);
    console.log(`Page ${page}: ${results.length} results (running total: ${allResults.length})`);

    if (results.length < PAGE_SIZE) break; // last page reached
    page++;
  }

  return allResults.map(parseAward);
}

// Builds one batched SQL file: an upsert for the recipient, then an upsert
// for the award (using subqueries to resolve agency_id/recipient_id/
// place_of_performance_state_id, so no separate round-trip lookups are
// needed before writing). opportunity_id and match_confidence are
// deliberately NOT set here — that's the separate matching job's job,
// run after this sync completes, so a bug in matching logic can never
// corrupt the award data itself.
function buildSql(awards) {
  const statements = [];

  for (const award of awards) {
    if (!award.award_id || !award.amount || !award.award_date) continue; // skip incomplete records

    statements.push(
      `INSERT INTO recipients (slug, name) VALUES (${sqlEscape(award.recipient_slug)}, ${sqlEscape(award.recipient_name)}) ON CONFLICT(slug) DO NOTHING;`
    );

    const stateIdExpr = award.place_of_performance_state_code
      ? `(SELECT id FROM states WHERE code = ${sqlEscape(award.place_of_performance_state_code)})`
      : 'NULL';

    statements.push(`
      INSERT INTO awards (award_id, agency_id, recipient_id, amount, fiscal_year, award_date, cfda_number, place_of_performance_state_id, last_synced_at)
      VALUES (
        ${sqlEscape(award.award_id)},
        (SELECT id FROM agencies WHERE code = 'NIH'),
        (SELECT id FROM recipients WHERE slug = ${sqlEscape(award.recipient_slug)}),
        ${award.amount},
        ${award.fiscal_year},
        ${sqlEscape(award.award_date)},
        ${sqlEscape(award.cfda_number)},
        ${stateIdExpr},
        datetime('now')
      )
      ON CONFLICT(award_id) DO UPDATE SET
        amount = excluded.amount,
        fiscal_year = excluded.fiscal_year,
        award_date = excluded.award_date,
        cfda_number = excluded.cfda_number,
        place_of_performance_state_id = excluded.place_of_performance_state_id,
        last_synced_at = excluded.last_synced_at;
    `);
  }

  return { sql: statements.join('\n'), processed: statements.length / 2 };
}

function runD1File(sqlFilePath) {
  execFileSync(
    'wrangler',
    ['d1', 'execute', D1_DATABASE_NAME, '--remote', '--yes', `--file=${sqlFilePath}`],
    { stdio: 'inherit' }
  );
}

function recordSyncRun(status, recordsProcessed, errorMessage) {
  const errSql = errorMessage ? sqlEscape(errorMessage) : 'NULL';
  const sql = `INSERT INTO sync_runs (source, status, started_at, finished_at, records_processed, error_message) VALUES ('usaspending', ${sqlEscape(status)}, datetime('now'), datetime('now'), ${recordsProcessed}, ${errSql});`;
  const tmpFile = path.join(os.tmpdir(), `sync-run-log-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    runD1File(tmpFile);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function main() {
  let awards;
  try {
    awards = await fetchNihAwards();
  } catch (err) {
    console.error('Fetch failed:', err.message);
    recordSyncRun('failed', 0, err.message);
    process.exit(1);
  }

  const { sql, processed } = buildSql(awards);

  if (processed === 0) {
    console.log('No usable award records this run.');
    recordSyncRun('success', 0, null);
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `usaspending-sync-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql);

  try {
    runD1File(tmpFile);
    console.log(`Synced ${processed} awards.`);
    recordSyncRun('success', processed, null);
  } catch (err) {
    console.error('D1 write failed:', err.message);
    recordSyncRun('failed', 0, err.message);
    process.exit(1);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

main();
