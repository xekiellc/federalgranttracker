// Federal Grant Tracker — sync worker (NIH awards from USASpending.gov)
//
// HONESTY NOTE: this is written against USASpending.gov's documented
// spending_by_award search API shape, but has NOT been tested against a live
// response — this sandbox has no network access to usaspending.gov. Expect
// the first real run may need adjustment, most likely to field names read
// off each result in parseAward(). The debug summary in the manual-trigger
// response is kept intentionally small (unlike the first pass on the
// Grants.gov sync) so a fix, if needed, is fast rather than another long
// back-and-forth.
//
// This worker runs on a schedule (see wrangler.toml) and also exposes a
// manual trigger via GET request, gated by a shared secret, so it can be
// debugged without waiting for the next scheduled run.

const USASPENDING_SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

// Federal fiscal year: Oct 1 – Sep 30. FY label = the year the FY ends in.
function currentFiscalYear() {
  const now = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
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

// USASpending's grant-family award type codes. NIH awards are typically
// "04" (Project Grant) or "05" (Cooperative Agreement), but the full grant
// set is included so this isn't overly narrow on a first pass.
const GRANT_AWARD_TYPE_CODES = ['02', '03', '04', '05', '06', '10', '11'];

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
    headers: { 'Content-Type': 'application/json' },
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

  const awards = results.map(parseAward);

  // Small debug summary — enough to diagnose a field-name or filter problem
  // on the first live run without dumping the full response.
  const summary = {
    resultsFound: results.length,
    totalMatchingUSASpending: json?.page_metadata?.count ?? null,
    firstRawResultKeys: results.length > 0 ? Object.keys(results[0]) : null,
    firstParsedAward: awards.length > 0 ? awards[0] : null,
  };

  return { awards, summary };
}

async function upsertRecipient(db, recipientName, recipientSlug) {
  await db
    .prepare(`INSERT OR IGNORE INTO recipients (slug, name) VALUES (?, ?)`)
    .bind(recipientSlug, recipientName)
    .run();

  const row = await db
    .prepare(`SELECT id FROM recipients WHERE slug = ?`)
    .bind(recipientSlug)
    .first();

  return row?.id;
}

async function upsertAward(db, nihAgencyId, recipientId, award) {
  await db
    .prepare(`
      INSERT INTO awards (
        award_id, agency_id, recipient_id, amount, fiscal_year, award_date, last_synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(award_id) DO UPDATE SET
        amount = excluded.amount,
        fiscal_year = excluded.fiscal_year,
        award_date = excluded.award_date,
        last_synced_at = excluded.last_synced_at
    `)
    .bind(
      award.award_id,
      nihAgencyId,
      recipientId,
      award.amount,
      award.fiscal_year,
      award.award_date
    )
    .run();
}

async function runSync(env) {
  const db = env.DB;
  const runStart = await db
    .prepare(`INSERT INTO sync_runs (source, status) VALUES ('usaspending', 'running')`)
    .run();
  const runId = runStart.meta.last_row_id;

  try {
    const nihAgency = await db
      .prepare(`SELECT id FROM agencies WHERE code = 'NIH'`)
      .first();
    if (!nihAgency) {
      throw new Error('NIH agency not found in agencies table — was seed.sql run?');
    }

    const { awards, summary } = await fetchNihAwards();

    let processed = 0;
    for (const award of awards) {
      if (!award.award_id || !award.amount || !award.award_date) continue; // skip incomplete records
      const recipientId = await upsertRecipient(db, award.recipient_name, award.recipient_slug);
      if (!recipientId) continue;
      await upsertAward(db, nihAgency.id, recipientId, award);
      processed++;
    }

    await db
      .prepare(
        `UPDATE sync_runs SET status = 'success', finished_at = datetime('now'), records_processed = ? WHERE id = ?`
      )
      .bind(processed, runId)
      .run();

    return { success: true, processed, summary };
  } catch (err) {
    await db
      .prepare(
        `UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'), error_message = ? WHERE id = ?`
      )
      .bind(String(err.message || err), runId)
      .run();

    return { success: false, error: String(err.message || err) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const providedSecret = url.searchParams.get('secret');

    if (!env.SYNC_SECRET) {
      return new Response(
        'Sync worker is deployed but SYNC_SECRET is not set — manual trigger disabled. Scheduled runs (every 6 hours) still work once deployed.',
        { status: 200 }
      );
    }

    if (providedSecret !== env.SYNC_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const result = await runSync(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
      status: result.success ? 200 : 500,
    });
  },
};
