#!/usr/bin/env node
// Federal Grant Tracker — opportunity lifecycle maintenance
//
// WHY THIS EXISTS: the Grants.gov sync (sync-worker/) only ever asks for
// oppStatuses: 'forecasted|posted' — it has no way to notice when a real
// opportunity closes, since a closed opportunity simply stops appearing in
// that query's results. Without this job, every opportunity would sit
// frozen at whatever status it last synced at, forever — even years after
// its real close_date has passed. close_date is already stored locally
// from the original sync, so this needs no external API calls: it's pure
// D1 logic, safe to run frequently.
//
// Two moves, both conservative and reversible if the underlying data is
// ever wrong:
//   1. forecasted/posted -> closed, once close_date has passed.
//   2. closed -> archived, once close_date is more than 180 days in the
//      past — separates "recently closed, still relevant context" from
//      "long done," matching the schema's own forecasted/posted/closed/
//      archived lifecycle (see schema.sql).
//
// Deliberately does NOT touch opportunities with a NULL close_date (some
// forecasted opportunities don't have one yet) — those stay exactly as
// Grants.gov itself reports them until a real close_date appears.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const D1_DATABASE_NAME = 'federalgranttracker';
const ARCHIVE_AFTER_DAYS = 180;

function runD1File(sqlFilePath) {
  execFileSync(
    'wrangler',
    ['d1', 'execute', D1_DATABASE_NAME, '--remote', '--yes', `--file=${sqlFilePath}`],
    { stdio: 'inherit' }
  );
}

async function queryD1(sql) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/ab74e758-2416-47f4-8dbe-4d44b540444b/query`;
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

async function main() {
  // Counts fetched via the D1 HTTP API first (not wrangler CLI, which was
  // confirmed earlier tonight not to return real row data for a SELECT —
  // see enrich-funding-opportunity.cjs for the full story), purely so the
  // log can honestly report how many rows are about to change before the
  // writes happen.
  const toCloseRows = await queryD1(`
    SELECT COUNT(*) as count FROM opportunities
    WHERE status IN ('forecasted', 'posted')
      AND close_date IS NOT NULL
      AND close_date < date('now');
  `);
  const toArchiveRows = await queryD1(`
    SELECT COUNT(*) as count FROM opportunities
    WHERE status = 'closed'
      AND close_date < date('now', '-${ARCHIVE_AFTER_DAYS} days');
  `);
  const toCloseCount = toCloseRows[0]?.count ?? 0;
  const toArchiveCount = toArchiveRows[0]?.count ?? 0;

  console.log(`Opportunities to close (past close_date): ${toCloseCount}`);
  console.log(`Opportunities to archive (closed ${ARCHIVE_AFTER_DAYS}+ days ago): ${toArchiveCount}`);

  if (toCloseCount === 0 && toArchiveCount === 0) {
    console.log('Nothing to update.');
    return;
  }

  const sql = `
    UPDATE opportunities
    SET status = 'closed', updated_at = datetime('now')
    WHERE status IN ('forecasted', 'posted')
      AND close_date IS NOT NULL
      AND close_date < date('now');

    UPDATE opportunities
    SET status = 'archived', updated_at = datetime('now')
    WHERE status = 'closed'
      AND close_date < date('now', '-${ARCHIVE_AFTER_DAYS} days');
  `;

  const tmpFile = path.join(os.tmpdir(), `archive-opportunities-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql);
  try {
    runD1File(tmpFile);
    console.log(`Closed ${toCloseCount} opportunities, archived ${toArchiveCount} opportunities.`);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

main();
