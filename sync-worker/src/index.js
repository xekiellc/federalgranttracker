// Federal Grant Tracker — sync worker (opportunities from Grants.gov, all tracked agencies)
//
// UPDATE 2: two real bugs found from a live run's perAgencySummary output —
//
// (1) USDA/DOD/DOE/HHS returned 0-2 hits each, while NSF (138 total) and
//     NIH (691 total) worked fine. Root cause: USDA/DOD/DOE/HHS are parent
//     departments with dozens of subagencies, and most Grants.gov records
//     are tagged with the specific subagency code (e.g. "USDA-NIFA"), not
//     the bare parent code ("USDA") — the exact same issue NIH originally
//     hit needing "HHS-NIH11" instead of "HHS". NSF and NIH already worked
//     because NSF is flat (no subagencies) and NIH's code was already
//     subagency-specific. Fixed by passing every subagency code we already
//     confirmed live (from an earlier debug run's full agency facet dump)
//     as a pipe-separated list, matching the same pipe-delimited format
//     already used for oppStatuses.
//
// (2) rows was capped at 50 regardless of an agency's real total (HHS
//     alone has 935 open+forecasted opportunities per that same debug
//     dump) — raised per-agency row cap so real totals aren't truncated.
//
// UPDATE 3: fixed a slug-collision bug (title truncation was silently
// dropping the opportunity number). UPDATE 4: after that shipped, a run
// still hit slug collisions on the larger agencies AND threw a full
// "Worker threw exception" (Error 1101) — a real execution-time limit,
// from looping hundreds of individual sequential D1 writes in one
// invocation now that real full result sets (up to 1000 rows/agency) are
// being fetched. Fixed by switching to a single db.batch() call per
// agency instead of sequential awaited writes, and deduping by
// opportunity_number in-memory first, since Grants.gov's pipe-joined
// multi-subagency query can return the same real opportunity once per
// matching subagency code within a single response.
//
// This worker runs on a schedule (see wrangler.toml) and also exposes a
// manual trigger via GET request, gated by a shared secret, so it can be
// debugged without waiting for the next scheduled run.

const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';

const VALID_STATUSES = ['forecasted', 'posted', 'closed', 'archived'];

// Raised from 50. Largest known real total (HHS, including subagencies) is
// 935 as of the debug run this was sourced from; 1000 covers that with
// headroom. If Grants.gov silently caps this lower, the next run's
// perAgencySummary hitsFound will show it and we can adjust.
const ROWS_PER_REQUEST = 1000;

// local agencies.code -> Grants.gov's own agency filter value(s). For
// parent departments, this is every subagency code confirmed live in an
// earlier debug run, pipe-joined (plus the bare parent code, since a few
// records do use it directly — e.g. DOD). Order matters: broader agencies
// first, more specific subagencies (NIH) last, so specific attribution
// wins on overlapping opportunities via the upsert's ON CONFLICT.
const AGENCY_SYNC_ORDER = [
  {
    localCode: 'USDA',
    grantsGovValue: [
      'USDA', 'USDA-AMS', 'USDA-APHIS', 'USDA-FAS', 'USDA-FS', 'USDA-NIFA',
      'USDA-NRCS', 'USDA-RBCS', 'USDA-RHS', 'USDA-RUS',
    ].join('|'),
  },
  {
    localCode: 'DOD',
    grantsGovValue: [
      'DOD', 'DOD-AMC-ACCAPGN', 'DOD-AFRL-AFRLDET8', 'DOD-AFRL', 'DOD-USAFA',
      'DOD-AFOSR', 'DOD-AMC-ACCRI', 'DOD-DARPA-BTO', 'DOD-DARPA-DSO',
      'DOD-DARPA-IPTO', 'DOD-DARPA-TTO', 'DOD-AMRAA', 'DOD-DTRA', 'DOD-AMC',
      'DOD-COE-ERDC', 'DOD-COE-FW', 'DOD-AFRL-RW', 'DOD-NGIA', 'DOD-ONR-AIR',
      'DOD-ONR-NRL', 'DOD-ONR-SUP', 'DOD-ONR-SEA-CRANE', 'DOD-ONR-SEA-N00178',
      'DOD-OEA', 'DOD-ONR', 'DOD-AF347CS', 'DOD-WHS',
    ].join('|'),
  },
  {
    localCode: 'DOE',
    grantsGovValue: [
      'DOE', 'DOE-ARPAE', 'DOE-GFO', 'DOE-01', 'DOE-ID', 'DOE-NETL', 'PAMS', 'PAMS-SC',
    ].join('|'),
  },
  { localCode: 'NSF', grantsGovValue: 'NSF' },
  {
    localCode: 'HHS',
    grantsGovValue: [
      'HHS', 'HHS-ASPR', 'HHS-ACF-FYSB', 'HHS-ACF', 'HHS-ACF-CB', 'HHS-ACF-OCS',
      'HHS-ACF-OFA', 'HHS-ACF-OFVPS', 'HHS-ACF-ORR', 'HHS-ACL', 'HHS-OS-ASPR',
      'HHS-CMS', 'HHS-CDC-CSTLTS', 'HHS-CDC-NCBDDD', 'HHS-CDC-NCCDPHP',
      'HHS-CDC-NCEZID', 'HHS-CDC-NCHHSTP', 'HHS-CDC-NCIPC', 'HHS-CDC-OD',
      'HHS-CDC-OPHPR', 'HHS-CDC-HHSCDCERA', 'HHS-CDC-GHC', 'HHS-FDA',
      'HHS-HRSA', 'HHS-IHS', 'HHS-OPHS', 'HHS-OS-ONC',
    ].join('|'),
  },
  { localCode: 'NIH', grantsGovValue: 'HHS-NIH11' },
  // Corrected via the debug=facets dump below: DOJ's real parent code is
  // 'USDOJ' (not 'DOJ'), and its live subagency facets showed
  // 'USDOJ-OJP-BJA', 'USDOJ-OJP-BJS', 'USDOJ-OJP-OVC' — all sibling
  // offices to NIJ under DOJ's Office of Justice Programs. NIJ itself
  // didn't appear in that facet dump, which just means it has zero
  // open/forecasted opportunities right now (NIJ's funding cycles are
  // often sporadic) — not that the code is wrong. 'USDOJ-OJP-NIJ' follows
  // the exact confirmed sibling pattern, so unlike the original 'DOJ-NIJ'
  // guess, a near-zero hitsFound here is expected and NOT itself evidence
  // of a wrong code — only revisit this if NIJ opportunities are known to
  // exist elsewhere (e.g. nij.ojp.gov) but never show up here over time.
  { localCode: 'NIJ', grantsGovValue: 'USDOJ-OJP-NIJ' },
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
    .replace(/(^-|-$)/g, '');
}

function buildSlug(title, opportunityNumber) {
  // Truncate the title portion BEFORE appending the opportunity number, so
  // the number — the actual unique identifier — is never cut off. The
  // previous version truncated the combined "title-number" string to 80
  // chars, which for long real titles silently dropped the number entirely,
  // making two different opportunities collide on the same slug even
  // though their opportunity_number (the real upsert key) differed.
  const titleSlug = slugify(title).slice(0, 60);
  const numberSlug = slugify(String(opportunityNumber));
  return `${titleSlug}-${numberSlug}`;
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
    slug: buildSlug(title, opportunityNumber),
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
      rows: ROWS_PER_REQUEST,
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

function buildUpsertStatement(db, agencyId, opp) {
  return db.prepare(`
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
  );
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
        const rawOpportunities = await fetchAgencyOpportunities(grantsGovValue);

        // Dedupe by opportunity_number in case Grants.gov's pipe-joined
        // multi-subagency query returns the same real opportunity once per
        // matching subagency code — batching duplicate opportunity_numbers
        // in a single db.batch() call isn't something ON CONFLICT can
        // safely resolve mid-batch, so collapse to one row per number here.
        const seen = new Map();
        for (const opp of rawOpportunities) {
          if (opp.opportunity_number) seen.set(opp.opportunity_number, opp);
        }
        const opportunities = Array.from(seen.values());

        const statements = opportunities.map((opp) => buildUpsertStatement(db, agencyRow.id, opp));

        let agencyProcessed = 0;
        let agencyFailed = 0;
        if (statements.length > 0) {
          const results = await db.batch(statements);
          for (const result of results) {
            if (result?.success !== false) {
              agencyProcessed++;
            } else {
              agencyFailed++;
            }
          }
        }

        totalProcessed += agencyProcessed;
        perAgencySummary.push({
          localCode,
          hitsFound: rawOpportunities.length,
          processed: agencyProcessed,
          ...(agencyFailed > 0 ? { rowsFailed: agencyFailed } : {}),
        });
      } catch (agencyErr) {
        // The agency's fetch or batch itself failing still skips that
        // whole agency for this run, without aborting the others.
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

    // Debug mode: ?secret=...&debug=facets — runs a broad, agency-unfiltered
    // search and scans the raw JSON response for any text mentioning
    // "justice", returning each match with surrounding context. This is the
    // same kind of live-data discovery that found every other agency's real
    // subagency code (see AGENCY_SYNC_ORDER's comments). Already used once
    // to find DOJ's real sibling codes — left in place in case it's useful
    // again (e.g. re-checking whether NIJ has picked up live opportunities).
    if (url.searchParams.get('debug') === 'facets') {
      try {
        const response = await fetch(GRANTS_GOV_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: 25, keyword: 'justice', oppStatuses: 'forecasted|posted' }),
        });
        const rawText = await response.text();
        const matches = [];
        const lower = rawText.toLowerCase();
        let searchFrom = 0;
        while (true) {
          const idx = lower.indexOf('justice', searchFrom);
          if (idx === -1) break;
          matches.push(rawText.slice(Math.max(0, idx - 120), idx + 120));
          searchFrom = idx + 7;
          if (matches.length >= 30) break; // safety cap
        }
        return new Response(JSON.stringify({ matchCount: matches.length, matches }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err.message || err) }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
          status: 500,
        });
      }
    }

    const result = await runSync(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
      status: result.success ? 200 : 500,
    });
  },
};
