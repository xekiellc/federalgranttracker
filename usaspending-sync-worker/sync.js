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
// HONESTY NOTE: the USASpending request shape (filters, field names) is
// unchanged from the Workers version and was never confirmed against a
// live response, since every prior attempt failed at the network layer
// before reaching this logic. Expect this first real run may still need
// adjustment to field names in parseAward() — same as happened with the
// Grants.gov sync.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const USASPENDING_SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const D1_DATABASE_NAME = 'federalgranttracker';
const GRANT_AWARD_TYPE_CODES = ['02', '03', '04', '05', '06', '10', '11'];

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
    .slice(0, 80);
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

  return {
    award_id: awardId,
    recipient_name: recipientName,
    recipient_slug: slugify(recipientName),
    amount: Number.isFinite(amount) ? amount : null,
    award_date: startDate,
    fiscal_year: startDate ? fiscalYearFromDate(startDate) : currentFiscalYear(),
  };
}

async function fetchNihAwards() {
  const fy = currentFiscalYear();
  const { start, end } = fiscalYearRange(fy);

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
      'generated_internal_id',
    ],
    page: 1,
    limit: 100,
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
    throw new Error(`USASpending request failed: ${response.status} ${response.statusText} — ${bodyText.slice(0, 300)}`);
  }

  const json = await response.json();
  const results = json?.results;
  if (!Array.isArray(results)) {
    throw new Error('Unexpected USASpending response shape: no results array found');
  }

  return results.map(parseAward);
}

// Builds one batched SQL file: an upsert for the recipient, then an upsert
// for the award (using subqueries to resolve agency_id/recipient_id, so no
// separate round-trip lookups are needed before writing).
function buildSql(awards) {
  const statements = [];

  for (const award of awards) {
    if (!award.award_id || !award.amount || !award.award_date) continue; // skip incomplete records

    statements.push(
      `INSERT INTO recipients (slug, name) VALUES (${sqlEscape(award.recipient_slug)}, ${sqlEscape(award.recipient_name)}) ON CONFLICT(slug) DO NOTHING;`
    );

    statements.push(`
      INSERT INTO awards (award_id, agency_id, recipient_id, amount, fiscal_year, award_date, last_synced_at)
      VALUES (
        ${sqlEscape(award.award_id)},
        (SELECT id FROM agencies WHERE code = 'NIH'),
        (SELECT id FROM recipients WHERE slug = ${sqlEscape(award.recipient_slug)}),
        ${award.amount},
        ${award.fiscal_year},
        ${sqlEscape(award.award_date)},
        datetime('now')
      )
      ON CONFLICT(award_id) DO UPDATE SET
        amount = excluded.amount,
        fiscal_year = excluded.fiscal_year,
        award_date = excluded.award_date,
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
