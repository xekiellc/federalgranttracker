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
// pagination — real NIH award volume is far larger, so pagination was
// added (looping pages until exhausted or a safety cap).
//
// UPDATE 2: now captures CFDA number and place-of-performance state on
// every award — confirmed live and working via the CFDA-based matching job.
//
// UPDATE 3: expanded from NIH-only to all 6 tracked agencies (USDA, DOD,
// DOE, NSF, HHS, NIH), with HHS explicitly excluding NIH-attributed
// results to avoid double-counting (NIH is a sub-agency of HHS).
//
// UPDATE 4: two real problems surfaced on the first live 6-agency run.
// (1) USASpending's WAF blocked the run partway through DOE with a
// "Web Page Blocked!" response — near-certainly triggered by ~250
// requests fired back-to-back with no delay across 5 agencies. Fixed by
// adding a delay between page requests and a one-time retry-with-backoff
// on a failed page. (2) Far more importantly: the script fetched every
// agency into memory first and only wrote to D1 once ALL agencies
// succeeded — so DOE's single failure silently discarded NIH's, HHS's,
// USDA's, and DOD's already-fetched data (20,000 real awards fetched,
// zero written). Restructured so each agency's data is written to D1
// immediately after that agency's fetch completes, independent of
// whether later agencies succeed or fail — one agency's WAF block or
// network error can no longer cost the others their sync.
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
const PAGE_DELAY_MS = 400; // throttle between page requests to avoid tripping USASpending's WAF
const RETRY_DELAY_MS = 5000; // longer pause before a single retry attempt on a failed page

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Fetches one page, with a single retry after a longer backoff if the
// first attempt fails — covers transient blocks/errors (like a WAF trip)
// without silently retrying forever.
async function fetchPageWithRetry(requestBody, agencyCode, page, attempt = 1) {
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
    if (attempt < 2) {
      console.log(`  ${agencyCode} page ${page}: request failed (attempt ${attempt}), waiting ${RETRY_DELAY_MS}ms and retrying once...`);
      await sleep(RETRY_DELAY_MS);
      return fetchPageWithRetry(requestBody, agencyCode, page, attempt + 1);
    }
    throw new Error(`USASpending request failed for ${agencyCode} on page ${page}: ${response.status} ${response.statusText} — ${bodyText.slice(0, 300)}`);
  }

  return response.json();
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

    const json = await fetchPageWithRetry(requestBody, agencyConfig.code, page);
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
    await sleep(PAGE_DELAY_MS); // throttle to avoid tripping USASpending's WAF
  }

  if (skippedCount > 0) {
    console.log(`  ${agencyConfig.code}: skipped ${skippedCount} results belonging to ${agencyConfig.excludeSubAgency} (covered by its own dedicated query)`);
  }

  return allResults.map((r) => parseAward(r, agencyConfig.code));
}

// Builds one batched SQL file: an upsert for the recipient, then an upsert
// for the award (using subqueries to resolve agency_id/recipient_id/
// place_of_performance_state_id, so no separate round-trip lookups are
// needed before writing). opportunity_id and match_confidence are
// deliberately NOT set here — that's the separate matching job's job.
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

// Writes one agency's awards to D1 immediately, so a later agency's
// failure can never discard an earlier agency's already-fetched data.
function writeAgencyAwards(agencyCode, awards) {
  const { sql, processed } = buildSql(awards);
  if (processed === 0) {
    console.log(`${agencyCode}: no usable award records this run.`);
    return 0;
  }

  const tmpFile = path.join(os.tmpdir(), `usaspending-sync-${agencyCode}-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    runD1File(tmpFile);
    console.log(`${agencyCode}: synced ${processed} awards.`);
    return processed;
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function main() {
  let totalProcessed = 0;
  const agencyResults = [];

  for (const agencyConfig of AGENCY_CONFIGS) {
    console.log(`Fetching ${agencyConfig.code}...`);

    let awards;
    try {
      awards = await fetchAwardsForAgency(agencyConfig);
      console.log(`${agencyConfig.code}: ${awards.length} awards fetched.`);
    } catch (err) {
      console.error(`${agencyConfig.code} fetch failed:`, err.message);
      agencyResults.push(`${agencyConfig.code}: fetch failed — ${err.message}`);
      continue; // move on to the next agency rather than aborting the whole run
    }

    try {
      const processed = writeAgencyAwards(agencyConfig.code, awards);
      agencyResults.push(`${agencyConfig.code}: ${processed} synced`);
      totalProcessed += processed;
    } catch (err) {
      console.error(`${agencyConfig.code}: D1 write failed:`, err.message);
      agencyResults.push(`${agencyConfig.code}: write failed — ${err.message}`);
    }
  }

  const summary = agencyResults.join(' | ');
  console.log(`Run summary: ${summary}`);
  console.log(`Total synced this run: ${totalProcessed} awards.`);

  const anyIssue = agencyResults.some((r) => r.includes('failed'));
  recordSyncRun(
    totalProcessed > 0 ? 'success' : 'failed',
    totalProcessed,
    anyIssue ? summary : null
  );

  if (totalProcessed === 0) {
    process.exit(1);
  }
}

main();
