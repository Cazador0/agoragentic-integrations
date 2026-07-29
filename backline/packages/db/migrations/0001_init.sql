-- Backline initial schema.
--
-- The correctness spine from Solution C, on the deployment shape from A:
-- one Postgres, tenant_id + RLS (NOT schema-per-tenant, which the review
-- showed leaks across a transaction-pooled connection when search_path
-- survives a checkout).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------- tenancy

CREATE TABLE tenant (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principal (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('user','api_key','agent_session','service')),
  display_name  text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  -- Bumped on any permission change. Delegated tokens carry the version they
  -- were minted against, so revocation invalidates in-flight agent runs
  -- instead of taking effect only at next login.
  version       integer NOT NULL DEFAULT 1,
  -- An agent session ALWAYS names the user it acts for, or is a service
  -- principal with independently granted scopes. Enforced, not conventional.
  on_behalf_of  uuid REFERENCES principal(id),
  revoked_at    timestamptz,
  CONSTRAINT agent_session_names_delegator
    CHECK (kind <> 'agent_session' OR on_behalf_of IS NOT NULL)
);

CREATE INDEX principal_tenant_idx ON principal (tenant_id);

-- Per-user consent for an agent to act on their behalf. No row, no delegation.
CREATE TABLE agent_consent (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  agent_id      text NOT NULL,
  scopes        text[] NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  UNIQUE (user_id, agent_id)
);

-- MONEY and EGRESS are non-delegable at any depth. Asserted in the database as
-- well as in domain/delegation.ts, because a scope array is easy to widen by
-- accident in application code.
ALTER TABLE agent_consent ADD CONSTRAINT consent_excludes_non_delegable
  CHECK (NOT (scopes && ARRAY['MONEY','EGRESS']::text[]));

-- ------------------------------------------------------------------ core

CREATE TABLE company (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('venue','promoter','label','agency','brand')),
  hand_curated  boolean NOT NULL DEFAULT false,
  archived_at   timestamptz
);

CREATE TABLE contact (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  company_id    uuid REFERENCES company(id) ON DELETE SET NULL,
  full_name     text NOT NULL,
  email         citext,
  hand_curated  boolean NOT NULL DEFAULT false,
  archived_at   timestamptz
);

CREATE INDEX contact_name_trgm ON contact USING gin (full_name gin_trgm_ops);

CREATE TABLE artist (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('solo','band','dj','collective')),
  roster_status   text NOT NULL CHECK (roster_status IN ('prospect','signed','hiatus','former')),
  commission_bps  integer NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  home_timezone   text
);

-- A band is not a person; membership carries tenure so a departing member does
-- not rewrite booking history.
CREATE TABLE artist_member (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  artist_id   uuid NOT NULL REFERENCES artist(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  role        text NOT NULL,
  joined_on   date NOT NULL,
  left_on     date,
  CHECK (left_on IS NULL OR left_on >= joined_on)
);

CREATE TABLE venue (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  company_id    uuid REFERENCES company(id) ON DELETE SET NULL,
  name          text NOT NULL,
  city          text NOT NULL,
  country_code  char(2) NOT NULL,
  -- NOT NULL: every hold expiry and curfew is computed venue-local.
  timezone      text NOT NULL,
  capacity      integer CHECK (capacity > 0),
  currency      char(3) NOT NULL,
  hand_curated  boolean NOT NULL DEFAULT false
);

-- --------------------------------------------------------------- booking

CREATE TABLE booking (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  artist_id     uuid NOT NULL REFERENCES artist(id),
  venue_id      uuid NOT NULL REFERENCES venue(id),
  promoter_id   uuid REFERENCES company(id),
  tour_id       uuid,
  event_date    date NOT NULL,
  status        text NOT NULL CHECK (status IN
                  ('inquiry','held','offered','confirmed','contracted','played','settled','cancelled')),
  currency      char(3) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- THE double-booking constraint. Solution A could not express this (SQLite has
-- no EXCLUDE) and Solution B never stated it, leaving both able to confirm two
-- shows at the same venue on the same night.
ALTER TABLE booking ADD CONSTRAINT one_confirmed_show_per_venue_date
  EXCLUDE USING gist (
    venue_id WITH =,
    event_date WITH =
  ) WHERE (status IN ('confirmed','contracted','played','settled'));

CREATE TABLE hold (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id          uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  venue_id            uuid NOT NULL REFERENCES venue(id),
  event_date          date NOT NULL,
  level               integer NOT NULL CHECK (level BETWEEN 1 AND 5),
  status              text NOT NULL CHECK (status IN ('active','challenged','released','promoted','expired')),
  placed_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  challenged_by_hold_id uuid REFERENCES hold(id)
);

-- One occupant per rung. The service layer also enforces this, but the service
-- layer cannot survive two concurrent transactions; this can.
CREATE UNIQUE INDEX one_active_hold_per_level
  ON hold (venue_id, event_date, level)
  WHERE status IN ('active','challenged');

-- ----------------------------------------------------------------- offers

CREATE TABLE offer (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id            uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  version               integer NOT NULL CHECK (version > 0),
  supersedes_offer_id   uuid REFERENCES offer(id),
  status                text NOT NULL CHECK (status IN
                          ('draft','sent','countered','accepted','declined','expired')),
  deal_type             text NOT NULL CHECK (deal_type IN
                          ('flat','flat_plus_bonus','versus_split','door_split',
                           'backend_percentage','breakeven_plus_split')),
  guarantee_minor       bigint NOT NULL,
  currency              char(3) NOT NULL,
  split_bps             integer CHECK (split_bps BETWEEN 0 AND 10000),
  breakeven_minor       bigint,
  radius_km             integer CHECK (radius_km > 0),
  radius_days_before    integer CHECK (radius_days_before >= 0),
  radius_days_after     integer CHECK (radius_days_after >= 0),
  expires_at            timestamptz,
  sent_at               timestamptz,
  UNIQUE (booking_id, version)
);

-- An offer is immutable once sent. A counter creates version n+1.
CREATE OR REPLACE FUNCTION offer_immutable_after_send() RETURNS trigger AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL AND NEW.status = OLD.status
     AND (NEW.guarantee_minor, NEW.deal_type, NEW.split_bps) IS DISTINCT FROM
         (OLD.guarantee_minor, OLD.deal_type, OLD.split_bps) THEN
    RAISE EXCEPTION 'Offer % is immutable after send; create a new version instead.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offer_immutable BEFORE UPDATE ON offer
  FOR EACH ROW EXECUTE FUNCTION offer_immutable_after_send();

-- ------------------------------------------------------------ settlement

CREATE TABLE settlement (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id            uuid NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  status                text NOT NULL CHECK (status IN ('draft','submitted','approved','paid')),
  settlement_currency   char(3) NOT NULL,
  currency_of_record    char(3) NOT NULL,
  -- Captured at approval so the settled value cannot drift with the market.
  fx_rate_scaled        bigint,
  fx_captured_at        timestamptz,
  fx_source             text,
  approved_at           timestamptz,
  -- Amendment chain. Resolves "immutable after approval" against routine
  -- retroactive FX and withholding corrections: history is never mutated, the
  -- effective figure is the fold over the chain.
  amends_settlement_id  uuid REFERENCES settlement(id),
  CONSTRAINT approved_settlement_has_fx
    CHECK (status <> 'approved' OR settlement_currency = currency_of_record OR fx_rate_scaled IS NOT NULL)
);

CREATE TABLE settlement_line (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  settlement_id  uuid NOT NULL REFERENCES settlement(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN
                   ('guarantee','door','bonus','expense','commission','withholding_tax','vat','adjustment')),
  label          text NOT NULL,
  -- Integer minor units. No floats anywhere near money.
  amount_minor   bigint NOT NULL,
  currency       char(3) NOT NULL
);

-- There is exactly ONE place itemised money lives. The review found Solution C
-- carried both a jsonb expenses blob and line rows, with nothing reconciling
-- them; that duplication is not reproduced here.

CREATE OR REPLACE FUNCTION settlement_immutable_after_approval() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved','paid') AND NEW.status NOT IN ('approved','paid') THEN
    RAISE EXCEPTION 'Settlement % is immutable after approval; use crm_amend_settlement.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_immutable BEFORE UPDATE ON settlement
  FOR EACH ROW EXECUTE FUNCTION settlement_immutable_after_approval();

CREATE OR REPLACE FUNCTION settlement_line_frozen() RETURNS trigger AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM settlement
    WHERE id = COALESCE(NEW.settlement_id, OLD.settlement_id);
  IF parent_status IN ('approved','paid') THEN
    RAISE EXCEPTION 'Settlement lines are frozen after approval; create an amendment.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_line_frozen_trg
  BEFORE INSERT OR UPDATE OR DELETE ON settlement_line
  FOR EACH ROW EXECUTE FUNCTION settlement_line_frozen();

-- -------------------------------------------------------------- catalog

CREATE TABLE catalog (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name              text NOT NULL,
  owner_artist_id   uuid REFERENCES artist(id),
  label_company_id  uuid REFERENCES company(id)
);

CREATE TABLE release (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  catalog_id    uuid REFERENCES catalog(id) ON DELETE SET NULL,
  artist_id     uuid NOT NULL REFERENCES artist(id),
  title         text NOT NULL,
  type          text NOT NULL CHECK (type IN ('single','ep','album','compilation','live')),
  upc           text,
  release_date  date,
  UNIQUE (tenant_id, upc)
);

CREATE TABLE track (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  release_id   uuid REFERENCES release(id) ON DELETE SET NULL,
  title        text NOT NULL,
  isrc         char(12),
  duration_ms  integer CHECK (duration_ms > 0),
  UNIQUE (tenant_id, isrc)
);

CREATE TABLE work (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  title      text NOT NULL,
  iswc       char(11),
  UNIQUE (tenant_id, iswc)
);

-- Recording <-> composition, kept distinct.
CREATE TABLE track_work (
  track_id  uuid NOT NULL REFERENCES track(id) ON DELETE CASCADE,
  work_id   uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  PRIMARY KEY (track_id, work_id)
);

-- Per-territory shares as ROWS, not a JSON array. A jsonb splits[] cannot carry
-- territory, PRO affiliation or CWR capacity, which puts registration out of
-- reach — the review's finding against two of the three designs.
CREATE TABLE work_share (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  work_id           uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  party_contact_id  uuid NOT NULL REFERENCES contact(id),
  capacity          text NOT NULL CHECK (capacity IN ('CA','A','C','AR','E','AM','SE')),
  territory         char(2) NOT NULL,
  share_bps         integer NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  pro_affiliation   text
);

CREATE INDEX work_share_territory_idx ON work_share (work_id, territory);

-- ------------------------------------------------- timeline and provenance

-- Declared in the first migration so email ingestion is populating a table
-- rather than retrofitting a model. See docs/GAP-CLOSURES.md section 1.
CREATE TABLE activity (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  subject_uri           text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN
                          ('email','call','meeting','note','agent_action','sync','system')),
  thread_id             text,
  occurred_at           timestamptz NOT NULL,
  summary               text NOT NULL,
  body                  text,
  -- Derived at write time from the authoring principal. An agent's own note is
  -- UNTRUSTED input to the next agent: this is the stored-injection closure.
  trust                 text NOT NULL CHECK (trust IN ('SYSTEM','OPERATOR','UNTRUSTED')),
  author_principal_id   uuid REFERENCES principal(id)
);

CREATE INDEX activity_subject_idx ON activity (tenant_id, subject_uri, occurred_at DESC);
CREATE INDEX activity_thread_idx ON activity (tenant_id, thread_id);

-- Messages that could not be associated to a record. Same human review queue as
-- duplicate resolution and import survivorship: one queue, three producers.
CREATE TABLE unmatched_message (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  message_id    text NOT NULL,
  from_address  citext NOT NULL,
  subject       text,
  received_at   timestamptz NOT NULL,
  resolved_at   timestamptz,
  UNIQUE (tenant_id, message_id)
);

CREATE TABLE property_history (
  id                   bigserial PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  object_type          text NOT NULL,
  record_id            uuid NOT NULL,
  property             text NOT NULL,
  value                text,
  source_type          text NOT NULL CHECK (source_type IN ('USER','API','IMPORT','AGENT','SYNC')),
  source_id            text,
  agent_session_id     uuid,
  model_used           text,
  confidence           real,
  occurred_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX property_history_record_idx ON property_history (tenant_id, object_type, record_id, occurred_at DESC);

-- ------------------------------------------------------- ledger + outbox

CREATE TABLE event_log (
  offset_id     bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL REFERENCES principal(id),
  operation_id  text NOT NULL,
  object_type   text NOT NULL,
  record_id     uuid,
  action        text NOT NULL,
  intent        jsonb NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only, enforced by the database rather than by convention.
CREATE OR REPLACE FUNCTION prevent_event_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event_log is append-only (attempted %).', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_append_only
  BEFORE UPDATE OR DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION prevent_event_log_mutation();

-- Per-consumer offsets, so a throttled monday sync cannot back up UI liveness
-- or the public journal behind it (the coupled-fanout defect in Solution B).
CREATE TABLE outbox_consumer (
  consumer       text NOT NULL,
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  last_offset    bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, tenant_id)
);

-- ------------------------------------------------------------- approvals

CREATE TABLE pending_approval (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  operation_id             text NOT NULL,
  requested_by_principal   uuid NOT NULL REFERENCES principal(id),
  intent                   jsonb NOT NULL,
  egress_findings          jsonb NOT NULL DEFAULT '[]',
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','allowed','denied','expired')),
  resolved_by_principal    uuid REFERENCES principal(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  resolved_at              timestamptz
);

CREATE INDEX pending_approval_open_idx ON pending_approval (tenant_id, status) WHERE status = 'pending';

-- --------------------------------------------------------------- metering

CREATE TABLE usage_event (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL REFERENCES principal(id),
  operation_id  text NOT NULL,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  cost_micros   bigint NOT NULL DEFAULT 0,
  duration_ms   integer NOT NULL DEFAULT 0,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_event_tenant_idx ON usage_event (tenant_id, occurred_at DESC);

CREATE TABLE tenant_budget (
  tenant_id       uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  period_start    date NOT NULL,
  limit_micros    bigint NOT NULL,
  spent_micros    bigint NOT NULL DEFAULT 0
);

-- ------------------------------------------------------- agent registry

CREATE TABLE agent_registry_entry (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  agent_id          text NOT NULL,
  version           text NOT NULL,
  source            text NOT NULL CHECK (source IN ('registry','custom')),
  manifest          jsonb NOT NULL,
  installed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id)
);

-- Credential status per (agent, principal) so the panel can render the state
-- teams actually hit: "healthy for Alice, unauthenticated for Bob".
CREATE TABLE agent_credential (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  agent_id      text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('tenant','user')),
  principal_id  uuid REFERENCES principal(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('healthy','unauthenticated','expired','error')),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, principal_id)
);

-- ---------------------------------------------------------------- dedupe

CREATE TABLE match_candidate (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  object_type  text NOT NULL,
  left_id      uuid NOT NULL,
  right_id     uuid NOT NULL,
  score        real NOT NULL CHECK (score BETWEEN 0 AND 1),
  reasons      jsonb NOT NULL DEFAULT '[]',
  resolved_at  timestamptz,
  UNIQUE (tenant_id, object_type, left_id, right_id)
);

CREATE TABLE merge_log (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  object_type   text NOT NULL,
  primary_id    uuid NOT NULL,
  merged_id     uuid NOT NULL,
  survivorship  jsonb NOT NULL,
  merged_by     uuid NOT NULL REFERENCES principal(id),
  merged_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ migration

CREATE TABLE reconciliation_run (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_system  text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  records_compared integer NOT NULL DEFAULT 0,
  drift_count      integer NOT NULL DEFAULT 0,
  report         jsonb
);

-- ---------------------------------------------------------------- RLS
-- tenant_id + row-level security rather than schema-per-tenant. The review
-- showed schema isolation leaks under transaction pooling when search_path
-- survives a connection checkout, and offers no defence in depth.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('backline.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company','contact','artist','artist_member','venue','booking','hold','offer',
    'settlement','settlement_line','catalog','release','track','work','work_share',
    'activity','unmatched_message','property_history','event_log','pending_approval',
    'usage_event','agent_registry_entry','agent_credential','match_candidate',
    'merge_log','reconciliation_run','agent_consent','principal'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) '
      'WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- ------------------------------------------------- RLS enforcement guard
--
-- Verified the hard way while building this schema: with FORCE ROW LEVEL
-- SECURITY set and every policy in place, a SUPERUSER (or any role with
-- BYPASSRLS) still reads across tenants and no error is raised. Connecting the
-- application as the bootstrap/superuser role therefore makes the entire
-- tenancy guarantee inert, silently.
--
-- That is the same failure class the architecture review raised against
-- schema-per-tenant: a single connection-level setting is the difference
-- between isolation and a full cross-tenant read. So the guard is not a
-- convention in a runbook — the application refuses to start without it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backline_app') THEN
    CREATE ROLE backline_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO backline_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO backline_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO backline_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO backline_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO backline_app;

-- Called on every pool checkout by packages/db. Fails closed and loudly.
CREATE OR REPLACE FUNCTION assert_rls_enforced() RETURNS void AS $$
DECLARE bypasses boolean;
BEGIN
  SELECT rolsuper OR rolbypassrls INTO bypasses
    FROM pg_roles WHERE rolname = current_user;
  IF bypasses THEN
    RAISE EXCEPTION
      'Refusing to serve: current_user % bypasses row-level security, so tenant '
      'isolation would not be enforced. Connect as backline_app.', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'Refusing to serve: backline.tenant_id is not set on this connection.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$ LANGUAGE plpgsql;
