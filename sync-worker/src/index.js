// Federal Grant Tracker — sync worker (opportunities from Grants.gov, all tracked agencies)
//
// UPDATE: originally NIH-only. Broadened to loop through all agencies in
// the `agencies` table, since USDA/DOD/DOE/HHS/NSF have real Grants.gov
// agency codes we already confirmed live in an earlier debug run of this
// same worker (when the agency filter was left empty and Grants.gov
// returned its full agency facet list). HHS is queried before NIH
// specifically, since NIH's opportunities also show up under the broader
// HHS query — querying NIH last ensures those opportunities end up
// correctly attributed to NIH rather than the broader HHS bucket, since
// the upsert's ON CONFLICT overwrites agency_id with whichever run
// processed a given opportunity_number most recently.
//
// This worker runs on a schedule (see wrangler.toml) and also exposes a
// manual trigger via GET request, gated by a shared secret, so it can be
// debugged without waiting for the next scheduled run.

const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';

const VALID_STATUSES = ['forecasted', 'posted', 'closed', 'archived'];

// local agencies.code -> Grants.gov's own agency filter value. Order
// matters: broader agencies first, more specific subagencies last, so
// specific attribution wins on overlapping opportunities (see note above).
const AGENCY_SYNC_ORDER = [
  { localCode: 'USDA', grantsGovValue: 'USDA' },
  { localCode: 'DOD', grantsGovValue: 'DOD' },
  { localCode: 'DOE', grantsGovValue: 'DOE' },
  { localCode: 'NSF', grantsGovValue: 'NSF' },
  { localCode: 'HHS', grantsGovValue: 'HHS' },
  { localCode: 'NIH', grantsGovValue: 'HHS-NIH11' },
];

function toIsoDate(mmddyyyy) {
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

async function fetchAgencyOpportunities(grantsGovValue) {
  const response = await fetch(GRANTS_GOV_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: 50,
      keyword: '',
      oppStatuses: 'forecasted|posted',
      agencies: grantsGovValue,
    }),
  });

  if (!response.ok) {
    throw new Error(`Grants.gov request failed for ${grantsGovValue}: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const hits = json?.data?.oppHits;
  if (!Array.isArray(hits)) {
    throw new Error(`Unexpected Grants.gov response shape for ${grantsGovValue}: no data.oppHits array found`);
  }
  return hits.map(parseOpportunity);
}

async function upsertOpportunity(db, agencyId, opp) {
  await db.prepare(`
    INSERT INTO opportunities (
      slug, opportunity_number, title, agency_id, cfda_number,
      status, posted_date, close_date, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(opportunity_number) DO UPDATE SET
      title = excluded.title,
      agency_id = excluded.agency_id,
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
    agencyId,
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

  const perAgencySummary = [];
  let totalProcessed = 0;

  try {
    for (const { localCode, grantsGovValue } of AGENCY_SYNC_ORDER) {
      const agencyRow = await db.prepare(
        `SELECT id FROM agencies WHERE code = ?`
      ).bind(localCode).first();

      if (!agencyRow) {
        perAgencySummary.push({ localCode, skipped: 'not found in agencies table' });
        continue;
      }

      try {
        const opportunities = await fetchAgencyOpportunities(grantsGovValue);
        let agencyProcessed = 0;
        for (const opp of opportunities) {
          if (!opp.opportunity_number) continue;
          await upsertOpportunity(db, agencyRow.id, opp);
          agencyProcessed++;
        }
        totalProcessed += agencyProcessed;
        perAgencySummary.push({ localCode, hitsFound: opportunities.length, processed: agencyProcessed });
      } catch (agencyErr) {
        // One agency failing shouldn't abort the whole run — record it and
        // keep going with the rest.
        perAgencySummary.push({ localCode, error: String(agencyErr.message || agencyErr) });
      }
    }

    await db.prepare(
      `UPDATE sync_runs SET status = 'success', finished_at = datetime('now'), records_processed = ? WHERE id = ?`
    ).bind(totalProcessed, runId).run();

    return { success: true, processed: totalProcessed, perAgencySummary };
  } catch (err) {
    await db.prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = datetime('now'), error_message = ? WHERE id = ?`
    ).bind(String(err.message || err), runId).run();

    return { success: false, error: String(err.message || err), perAgencySummary };
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
