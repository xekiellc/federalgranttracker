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
// UPDATE 2: now captures CFDA number and place-of-performance state on
// every award — confirmed live and working (4,938 of 4,995 NIH awards
// successfully matched to opportunities via CFDA + agency, see
// match-opportunities.cjs for the matching logic itself).
//
// UPDATE 3: expanded from NIH-only to all 6 tracked agencies (USDA, DOD,
// DOE, NSF, HHS, NIH). NIH is a sub-agency of HHS, not a standalone
// department — querying HHS at the top level would re-return every NIH
// award nested inside it, and writing those under agency_id=HHS would
// silently overwrite the correct agency_id=NIH already set by the
// dedicated NIH query, breaking the matching job's agency_id join.
// The HHS query explicitly skips any result whose "Awarding Sub Agency"
// is "National Institutes of Health" for exactly this reason — those
// awards are already covered by the NIH query, which runs first.
//
// NOTE: funding_opportunity_number is still NOT populated by this script.
// That field only comes from USASpending's per-award detail endpoint, not
// the bulk search endpoint used here — left NULL honestly rather than
// faked, per the "no fabricated data" rule. CFDA-based matching
// ('cfda_inferred') is the real matching path.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const USASPENDING_SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const D1_DATABASE_NAME = 'federalgranttracker';
const GRANT_AWARD_TYPE_CODES = ['02', '03', '04', '05'];

// Mirrors the 6 agencies tracked by the Grants.gov sync. NIH is queried as
// its own subtier entity (matches agencies.code = 'NIH' in the schema);
// HHS is queried at toptier but excludes anything tagged as NIH, since
// NIH is nested inside HHS and is already covered by its own query above.
const AGENCY_CONFIGS = [
  { code: 'NIH', tier: 'subtier', name: 'National Institutes of Health', excludeSubAgency: null },
  { code: 'HHS', tier: 'toptier', name: 'Department of Health and Human Services', excludeSubAgency: 'National Institutes of Health' },
  { code: 'USDA', tier: 'toptier', name: 'Department of Agriculture', excludeSubAgency: null },
  { code: 'DOD', tier: 'toptier', name: 'Department of Defense', excludeSubAgency: null },
  { code: 'DOE', tier: 'toptier', name: 'Department of Energy', excludeSubAgency: null },
  { code: 'NSF', tier: 'toptier', name: 'National Science Foundation', excludeSubAgency: null },
];

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

function parseAward(result, agencyCode) {
  const awardId = result.generated_internal_id || result['Award ID'];
  const recipientName = result['Recipient Name'] || 'Unknown recipient';
  const amountRaw = result['Award Amount'];
  const amount = typeof amountRaw === 'number' ? Math.round(amountRaw) : parseInt(amountRaw, 10);
  const startDate = result['Start Date'] || null; // "YYYY-MM-DD"
  const cfdaNumber = result['CFDA Number'] || null;
  const placeOfPerformanceStateCode = result['Place of Performance State Code'] || null;

  return {
    award_id: awardId,
    agency_code: agencyCode,
    recipient_name: recipientName,
    recipient_slug: slugify(recipientName),
    amount: Number.isFinite(amount) ? amount : null,
    award_date: startDate,
    fiscal_year: startDate ? fiscalYearFromDate(startDate) : currentFiscalYear(),
    cfda_number: cfdaNumber,
    place_of_performance_state_code: placeOfPerformanceStateCode,
  };
}

async function fetchAwardsForAgency(agencyConfig) {
  const fy = currentFiscalYear();
  const { start, end } = fiscalYearRange(fy);

  // USASpending's own documented max page size is 100 — raising `limit`
  // isn't an option, so real coverage requires looping through pages.
  // Safety cap at 50 pages (5,000 awards) per agency per run to keep this
  // script's runtime bounded; if a given agency's real total exceeds
  // that, later runs will still catch up over time since every write is
  // an idempotent upsert.
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;

  let allResults = [];
  let page = 1;
  let skippedCount = 0;

  while (page <= MAX_PAGES) {
    const requestBody = {
      filters: {
        award_type_codes: GRANT_AWARD_TYPE_CODES,
        agencies: [{ type: 'awarding', tier: agencyConfig.tier, name: agencyConfig.name }],
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
      throw new Error(`USASpending request failed for ${agencyConfig.code} on page ${page}: ${response.status} ${response.statusText} — ${bodyText.slice(0, 300)}`);
    }

    const json = await response.json();
    const results = json?.results;
    if (!Array.isArray(results)) {
      throw new Error(`Unexpected USASpending response shape for ${agencyConfig.code} on page ${page}: no results array found`);
    }

    let pageResults = results;
    if (agencyConfig.excludeSubAgency) {
      const before = pageResults.length;
      pageResults = pageResults.filter((r) => r['Awarding Sub Agency'] !== agencyConfig.excludeSubAgency);
      skippedCount += before - pageResults.length;
    }

    allResults = allResults.concat(pageResults);
    console.log(`  ${agencyConfig.code} page ${page}: ${results.length} results (${pageResults.length} kept, running total: ${allResults.length})`);

    if (results.length < PAGE_SIZE) break; // last page reached
    page++;
  }

  if (skippedCount > 0) {
    console.log(`  ${agencyConfig.code}: skipped ${skippedCount} results belonging to ${agencyConfig.excludeSubAgency} (covered by its own dedicated query)`);
  }

  return allResults.map((r) => parseAward(r, agencyConfig.code));
}

async function fetchAllAwards() {
  let allAwards = [];
  for (const agencyConfig of AGENCY_CONFIGS) {
    console.log(`Fetching ${agencyConfig.code}...`);
    const agencyAwards = await fetchAwardsForAgency(agencyConfig);
    console.log(`${agencyConfig.code}: ${agencyAwards.length} awards fetched.`);
    allAwards = allAwards.concat(agencyAwards);
  }
  return allAwards;
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
        (SELECT id FROM agencies WHERE code = ${sqlEscape(award.agency_code)}),
        (SELECT id FROM recipients WHERE slug = ${sqlEscape(award.recipient_slug)}),
        ${award.amount},
        ${award.fiscal_year},
        ${sqlEscape(award.award_date)},
        ${sqlEscape(award.cfda_number)},
        ${stateIdExpr},
        datetime('now')
      )
      ON CONFLICT(award_id) DO UPDATE SET
        agency_id = excluded.agency_id,
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
    awards = await fetchAllAwards();
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
    console.log(`Synced ${processed} awards across ${AGENCY_CONFIGS.length} agencies.`);
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
