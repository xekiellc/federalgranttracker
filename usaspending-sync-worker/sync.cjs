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
// UPDATE 4: fixed a total-loss failure mode — one agency's fetch failing
// was discarding every other agency's already-fetched data, since writes
// only happened after ALL agencies succeeded. Restructured so each
// agency's data writes to D1 immediately after that agency's own fetch
// completes. Also added a per-page delay and a one-time retry with
// backoff on a failed page, since USASpending's WAF appeared to block the
// run (a "Web Page Blocked!" response) after ~250 rapid-fire requests.
//
// UPDATE 5: two live runs both saw DOE specifically fail on page 50 of 50
// — same page both times, even after the retry from UPDATE 4 also failed.
// That consistency suggested either (a) DOE's real volume sits right at a
// boundary that trips something every time, or (b) cumulative request
// count across the whole run (DOE is 5th of 6 agencies) crosses some WAF
// threshold regardless of which agency is being fetched at that point —
// supported by NSF (6th agency) succeeding once a longer pause happened
// to fall before it. Two changes: (1) fetchAwardsForAgency() no longer
// discards an agency's data when a later page fails — it now returns
// whatever was successfully fetched before the failure, so DOE's real
// 4,900 rows from pages 1-49 stop being thrown away over page 50 alone.
// (2) Added a pause between agencies (not just between pages), to test
// whether spacing out the *whole run* reduces cumulative WAF pressure,
// not just per-agency page pressure.
//
// UPDATE 6: added NIJ (National Institute of Justice), queried as its own
// subtier entity — same pattern as NIH under HHS, but without a separate
// "whole DOJ" query, since only NIJ specifically was asked for.
//
// UPDATE 7: added EXCLUDED_ENTITLEMENT_CFDAS — see the comment above that
// constant for the full story. In short: mandatory entitlement/formula
// programs (Medicaid, TANF, SNAP, WIC, etc.) pass the grant-type-code
// filter below but were silently dominating every dollar total on the
// site, since a handful of Medicaid records alone run into the hundreds
// of billions each.
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

// USASpending's own award-type classification (02/03/04/05, filtered above)
// lumps together two very different things: real discretionary/competitive
// grants that get posted as opportunities on Grants.gov, and mandatory
// entitlement/formula programs (Medicaid, TANF, SNAP, WIC, etc.) that are
// automatic state allocations and structurally never appear as a Grants.gov
// opportunity. The latter isn't a coding error on USASpending's part — it's
// a real category difference their type codes don't distinguish — but it
// silently dominates every dollar total on this site, since a handful of
// Medicaid records alone can run into the hundreds of billions each.
//
// Confirmed live on 2026-09-02 via a direct query: every CFDA below shows
// significant award volume in this database but ZERO matching rows in the
// opportunities table (the Grants.gov side) — objective evidence, not a
// guess, that these are entitlement/formula programs rather than tracked
// discretionary opportunities:
//   93.778 Medicaid, 10.555 National School Lunch, 93.558 TANF,
//   93.767 CHIP, 10.557 WIC, 10.561 SNAP State Admin,
//   93.658 Title IV-E Foster Care, 93.659 Title IV-E Adoption Assistance
// Five more show the identical zero-matching-opportunities signature but
// weren't individually identified by program name — included on the
// strength of that same live evidence rather than left in on a guess:
//   93.423, 93.600, 93.568, 93.563, 93.798
//
// This is a static list, not a live per-sync check against the
// opportunities table, specifically so a real competitive CFDA doesn't get
// wrongly excluded just because the Grants.gov sync (a fully independent
// schedule) hasn't yet caught up and posted its current opportunity. If
// USASpending data later reveals more entitlement CFDAs hiding in the
// totals, add them here explicitly rather than switching to an automatic
// check.
const EXCLUDED_ENTITLEMENT_CFDAS = new Set([
  '93.778', '10.555', '93.558', '93.767', '10.557', '10.561', '93.658', '93.659',
  '93.423', '93.600', '93.568', '93.563', '93.798',
]);
const PAGE_DELAY_MS = 400; // throttle between page requests within one agency
const AGENCY_DELAY_MS = 8000; // throttle between agencies, to ease cumulative WAF pressure
const RETRY_DELAY_MS = 5000; // longer pause before a single retry attempt on a failed page

// Mirrors the tracked agencies from the Grants.gov sync, plus NIJ. NIH and
// NIJ are each queried as their own subtier entity (matches agencies.code
// in the schema); HHS is queried at toptier but excludes anything tagged
// as NIH, since NIH is nested inside HHS and is already covered by its
// own query above. NIJ is nested inside DOJ, but DOJ itself isn't tracked
// as a whole department here — same pattern as NIH/HHS, just without the
// parent-department query, since only NIJ specifically was asked for.
const AGENCY_CONFIGS = [
  { code: 'NIH', tier: 'subtier', name: 'National Institutes of Health', excludeSubAgency: null },
  { code: 'HHS', tier: 'toptier', name: 'Department of Health and Human Services', excludeSubAgency: 'National Institutes of Health' },
  { code: 'USDA', tier: 'toptier', name: 'Department of Agriculture', excludeSubAgency: null },
  { code: 'DOD', tier: 'toptier', name: 'Department of Defense', excludeSubAgency: null },
  { code: 'DOE', tier: 'toptier', name: 'Department of Energy', excludeSubAgency: null },
  { code: 'NSF', tier: 'toptier', name: 'National Science Foundation', excludeSubAgency: null },
  { code: 'NIJ', tier: 'subtier', name: 'National Institute of Justice', excludeSubAgency: null },
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
// first attempt fails. Returns null (rather than throwing) if both
// attempts fail — the caller decides how to handle a failed page without
// losing pages that already succeeded.
async function fetchPageWithRetry(requestBody, agencyCode, page, attempt = 1) {
  let response;
  try {
    response = await fetch(USASPENDING_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'FederalGrantTracker/1.0 (+https://federalgranttracker.com)',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    response = null;
  }

  if (!response || !response.ok) {
    if (attempt < 2) {
      console.log(`  ${agencyCode} page ${page}: request failed (attempt ${attempt}), waiting ${RETRY_DELAY_MS}ms and retrying once...`);
      await sleep(RETRY_DELAY_MS);
      return fetchPageWithRetry(requestBody, agencyCode, page, attempt + 1);
    }
    console.log(`  ${agencyCode} page ${page}: failed after retry — stopping this agency here, keeping pages already fetched.`);
    return null;
  }

  return response.json();
}

// Returns { awards, incomplete, stoppedAtPage } — incomplete=true means a
// page failed after retrying, so this agency's data reflects everything
// fetched successfully up to that point, not the agency's real total.
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
  let incomplete = false;

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
    if (json === null) {
      incomplete = true;
      break; // keep whatever was fetched on prior pages; stop here rather than losing it all
    }

    const results = json?.results;
    if (!Array.isArray(results)) {
      console.log(`  ${agencyConfig.code} page ${page}: unexpected response shape (no results array) — stopping this agency here.`);
      incomplete = true;
      break;
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

  return {
    awards: allResults.map((r) => parseAward(r, agencyConfig.code)),
    incomplete,
    stoppedAtPage: incomplete ? page : null,
  };
}

// Builds one batched SQL file: an upsert for the recipient, then an upsert
// for the award (using subqueries to resolve agency_id/recipient_id/
// place_of_performance_state_id, so no separate round-trip lookups are
// needed before writing). opportunity_id and match_confidence are
// deliberately NOT set here — that's the separate matching job's job.
function buildSql(awards) {
  const statements = [];

  let excludedEntitlementCount = 0;

  for (const award of awards) {
    if (!award.award_id || !award.amount || !award.award_date) continue; // skip incomplete records
    if (award.cfda_number && EXCLUDED_ENTITLEMENT_CFDAS.has(award.cfda_number)) {
      excludedEntitlementCount++;
      continue; // mandatory entitlement/formula program, not a real grant opportunity — see EXCLUDED_ENTITLEMENT_CFDAS above
    }

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

  return { sql: statements.join('\n'), processed: statements.length / 2, excludedEntitlementCount };
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
  const { sql, processed, excludedEntitlementCount } = buildSql(awards);
  if (excludedEntitlementCount > 0) {
    console.log(`${agencyCode}: excluded ${excludedEntitlementCount} entitlement/formula-program records (see EXCLUDED_ENTITLEMENT_CFDAS).`);
  }
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

  for (let i = 0; i < AGENCY_CONFIGS.length; i++) {
    const agencyConfig = AGENCY_CONFIGS[i];
    console.log(`Fetching ${agencyConfig.code}...`);

    let fetchResult;
    try {
      fetchResult = await fetchAwardsForAgency(agencyConfig);
      const note = fetchResult.incomplete ? ` (stopped early at page ${fetchResult.stoppedAtPage} — kept everything fetched before that)` : '';
      console.log(`${agencyConfig.code}: ${fetchResult.awards.length} awards fetched${note}.`);
    } catch (err) {
      console.error(`${agencyConfig.code} fetch failed:`, err.message);
      agencyResults.push(`${agencyConfig.code}: fetch failed — ${err.message}`);
      continue;
    }

    try {
      const processed = writeAgencyAwards(agencyConfig.code, fetchResult.awards);
      const partialNote = fetchResult.incomplete ? ' (partial)' : '';
      agencyResults.push(`${agencyConfig.code}: ${processed} synced${partialNote}`);
      totalProcessed += processed;
    } catch (err) {
      console.error(`${agencyConfig.code}: D1 write failed:`, err.message);
      agencyResults.push(`${agencyConfig.code}: write failed — ${err.message}`);
    }

    // Pause between agencies (not just between pages) — testing whether
    // cumulative request volume across the whole run, not just one
    // agency's page count, is what's tripping USASpending's WAF.
    if (i < AGENCY_CONFIGS.length - 1) {
      await sleep(AGENCY_DELAY_MS);
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
