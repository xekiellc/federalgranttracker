// Federal Grant Tracker — sync worker (NIH opportunities from Grants.gov)
//
// HONESTY NOTE: the Grants.gov API call and response parsing below are written
// against the publicly documented shape of the search2 endpoint, but this has
// NOT been tested against a live response — this sandbox has no network access
// to grants.gov. Expect the first real run to need adjustment, most likely to
// the field names read off each search hit in parseOpportunity(). Everything
// database-side (the upsert logic) HAS been tested against the real schema.
//
// This worker runs on a schedule (see wrangler.toml) and also exposes a manual
// trigger via GET request, gated by a shared secret, so it can be debugged
// without waiting for the next scheduled run.

const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';

// Grants.gov's own opportunity statuses line up directly with the CHECK
// constraint on opportunities.status in schema.sql — forecasted/posted/
// closed/archived — so no mapping table is needed, just pass the value
// through (lowercased, defensively).
const VALID_STATUSES = ['forecasted', 'posted', 'closed', 'archived'];

function toIsoDate(mmddyyyy) {
  // Grants.gov dates are typically "MM/DD/YYYY"; convert to "YYYY-MM-DD" so
  // they sort correctly as TEXT in SQLite. Returns null if unparseable
  // rather than throwing, so one bad date doesn't kill the whole sync.
  if (!mmddyyyy || typeof mmddyyyy !== 'string') return null;
  const parts = mmddyyyy.split('/');
  if (parts.length !== 3) return null;
  const [mm, dd, yyyy] = parts;
  if (!mm || !dd || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function parseOpportunity(hit) {
  // Best-guess field names based on Grants.gov's documented search2 response.
  // If the live response differs, these are the lines to fix first.
  const opportunityNumber = hit.number || hit.opportunityNumber || hit.id;
  const title = hit.title || 'Untitled opportunity';
  let status = (hit.oppStatus || hit.status || 'posted').toLowerCase();
  if (!VALID_STATUSES.includes(status)) status = 'posted';

  const cfdaNumber = Array.isArray(hit.cfdaList) && hit.cfdaList.length > 0
    ? hit.cfdaList[0]
    : (hit.cfda || null);

  return {
    opportunity_number: opportunityNumber,
    slug: slugify(`${title}-${opportunityNumber}`),
    title,
    cfda_number: cfdaNumber,
    status,
    posted_date: toIsoDate(hit.openDate),
    close_date: toIsoDate(hit.closeDate),
  };
}

async function fetchNihOpportunities() {
  const response = await fetch(GRANTS_GOV_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: 50,
      keyword: '',
      oppStatuses: 'forecasted|posted',
      agencies: 'HHS-NIH',
    }),
  });

  if (!response.ok) {
    throw new Error(`Grants.gov request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const hits = json?.data?.oppHits;
  if (!Array.isArray(hits)) {
    throw new Error('Unexpected Grants.gov response shape: no data.oppHits array found');
  }
  return hits.map(parseOpportunity);
}

async function upsertOpportunity(db, nihAgencyId, opp) {
  await db.prepare(`
    INSERT INTO opportunities (
      slug, opportunity_number, title, agency_id, cfda_number,
      status, posted_date, close_date, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(opportunity_number) DO UPDATE SET
      title = excluded.title,
      cfda_number = excluded.cfda_number,
      status = excluded.status,
      posted_date = excluded.posted_date,
      close_date = excluded.close_date,
      last_synced_at = excluded.last_synced_at,
      updated_at = datetime('now')
  `).bind(
    opp.slug,
    opp.opportunity_number,
    opp.title,
    nihAgencyId,
    opp.cfda_number,
    opp.status,
    opp.posted_date,
    opp.close_date
  ).run();
}

async function runSync(env) {
  const db = env.DB;
  const runStart = await db.prepare(
    `INSERT INTO sync_runs (source, status) VALUES ('grants_gov', 'running')`
  ).run();
  const runId = runStart.meta.last_row_id;

  try {
    const nihAgency = await db.prepare(
      `SELECT id FROM agencies WHERE code = 'NIH'`
    ).first();
    if (!nihAgency) {
      throw new Error('NIH agency not found in agencies table — was seed.sql run?');
    }

    const opportunities = await fetchNihOpportunities();

    let processed = 0;
    for (const opp of opportunities) {
      if (!opp.opportunity_number) continue; // skip anything we can't uniquely identify
      await upsertOpportunity(db, nihAgency.id, opp);
      processed++;
    }

    await db.prepare(
      `UPDATE sync_runs SET status = 'success', finished_at = datetime('now'), records_processed = ? WHERE id = ?`
    ).bind(processed, runId).run();

    return { success: true, processed };
  } catch (err) {
    await db.prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'), error_message = ? WHERE id = ?`
    ).bind(String(err.message || err), runId).run();

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

    // Manual trigger for debugging — requires SYNC_SECRET to be set via
    // `wrangler secret put SYNC_SECRET` (or the dashboard) before this does
    // anything. Until that's set, this just returns a status message.
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
