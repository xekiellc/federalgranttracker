-- Federal Grant Tracker — initial schema
-- Entities: agencies, opportunities, awards, recipients, states
-- Opportunity status and award status are deliberately separate: an opportunity's
-- lifecycle (forecasted/posted/closed/archived) is independent of how many awards
-- have been reported against it, since they come from different data sources
-- (Grants.gov vs. USASpending.gov) on different schedules.

CREATE TABLE agencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,          -- e.g. "nih", "hhs" — used in /agency/:slug
  code TEXT NOT NULL UNIQUE,          -- e.g. "NIH" — short agency code
  name TEXT NOT NULL,                 -- e.g. "National Institutes of Health"
  parent_agency_id INTEGER,           -- e.g. NIH's parent is HHS
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_agency_id) REFERENCES agencies(id)
);

CREATE TABLE states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,          -- two-letter, e.g. "OH"
  slug TEXT NOT NULL UNIQUE,          -- e.g. "ohio" — used in /state/:slug
  name TEXT NOT NULL,                 -- e.g. "Ohio"
  population INTEGER,                 -- for per-capita calculations
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,          -- e.g. "cleveland-clinic" — used in /recipient/:slug
  name TEXT NOT NULL,
  uei TEXT UNIQUE,                    -- SAM.gov Unique Entity Identifier, when known
  recipient_type TEXT,                -- university, nonprofit, company, government, other
  city TEXT,
  state_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (state_id) REFERENCES states(id)
);

-- Opportunities: sourced from Grants.gov. Status here is the opportunity's own
-- lifecycle only — it does NOT mean "awarded." See awards table for that.
CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,                    -- used in /opportunity/:slug
  opportunity_number TEXT NOT NULL UNIQUE,      -- Grants.gov's own identifier
  title TEXT NOT NULL,
  agency_id INTEGER NOT NULL,
  cfda_number TEXT,                             -- assistance listing / CFDA number
  funding_mechanism TEXT,                       -- e.g. "R01 — Research Project Grant"
  description TEXT,
  eligible_applicants TEXT,
  status TEXT NOT NULL DEFAULT 'forecasted'
    CHECK (status IN ('forecasted', 'posted', 'closed', 'archived')),
  estimated_total_funding INTEGER,              -- in whole dollars
  award_ceiling INTEGER,
  award_floor INTEGER,
  expected_number_of_awards INTEGER,
  posted_date TEXT,
  close_date TEXT,
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agency_id) REFERENCES agencies(id)
);

-- Awards: sourced from USASpending.gov. Related to an opportunity when a match
-- can be made (via CFDA number / agency / timing), but opportunity_id may be
-- NULL — plenty of awards won't cleanly match a tracked opportunity, especially
-- early on, and that's fine: the award record still stands on its own.
CREATE TABLE awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  award_id TEXT NOT NULL UNIQUE,      -- USASpending's own identifier
  opportunity_id INTEGER,             -- nullable: not every award matches a tracked opportunity
  agency_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,            -- in whole dollars
  fiscal_year INTEGER NOT NULL,
  award_date TEXT NOT NULL,
  cfda_number TEXT,
  funding_opportunity_number TEXT,    -- reported by the awarding agency in some FABS submissions;
                                       -- when present, this is the strongest signal for matching
                                       -- an award back to its Grants.gov opportunity
  match_confidence TEXT,              -- 'exact' (matched on funding_opportunity_number) |
                                       -- 'cfda_inferred' (matched on cfda_number + agency + timing) |
                                       -- NULL (no opportunity match found)
  description TEXT,
  place_of_performance_state_id INTEGER,  -- where the funded work happens (may differ from recipient's address)
  last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id),
  FOREIGN KEY (agency_id) REFERENCES agencies(id),
  FOREIGN KEY (recipient_id) REFERENCES recipients(id),
  FOREIGN KEY (place_of_performance_state_id) REFERENCES states(id)
);

-- Tracks each data pull so the "about this data" page can show real freshness
-- info instead of a hardcoded date.
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('grants_gov', 'usaspending')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  records_processed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  error_message TEXT
);

-- Indexes for the lookups the site actually does: recipient/agency/state pages,
-- "newest opportunity," "recently awarded," and the follow feature down the line.
CREATE INDEX idx_opportunities_agency ON opportunities(agency_id);
CREATE INDEX idx_opportunities_status ON opportunities(status);
CREATE INDEX idx_opportunities_posted_date ON opportunities(posted_date);
CREATE INDEX idx_opportunities_cfda_number ON opportunities(cfda_number);
CREATE INDEX idx_awards_opportunity ON awards(opportunity_id);
CREATE INDEX idx_awards_agency ON awards(agency_id);
CREATE INDEX idx_awards_recipient ON awards(recipient_id);
CREATE INDEX idx_awards_award_date ON awards(award_date);
CREATE INDEX idx_awards_state ON awards(place_of_performance_state_id);
CREATE INDEX idx_awards_cfda_number ON awards(cfda_number);
CREATE INDEX idx_recipients_state ON recipients(state_id);
