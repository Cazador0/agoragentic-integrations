-- Schema constraint tests.
--
-- Every assertion here inverts the usual shape: the test FAILS if the database
-- accepts a write it should have rejected. A constraint nobody proves is a
-- comment.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/tests/constraints.sql

\set ON_ERROR_STOP on
BEGIN;

INSERT INTO tenant (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'Test Agency');
SET LOCAL backline.tenant_id = '11111111-1111-1111-1111-111111111111';

INSERT INTO principal (id, tenant_id, kind, display_name, scopes) VALUES
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','user','Alice',ARRAY['READ','WRITE']);
INSERT INTO artist (id, tenant_id, name, kind, roster_status, commission_bps) VALUES
  ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','Test Band','band','signed',1000);
INSERT INTO venue (id, tenant_id, name, city, country_code, timezone, currency) VALUES
  ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','The Fillmore','San Francisco','US','America/Los_Angeles','USD');
INSERT INTO booking (id, tenant_id, artist_id, venue_id, event_date, status, currency) VALUES
  ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','2026-09-14','confirmed','USD');

CREATE OR REPLACE FUNCTION must_reject(stmt text, label text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  %  (rejected: %)', label, left(SQLERRM, 70);
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  %  — the database ACCEPTED a write it must reject.', label;
END;
$$ LANGUAGE plpgsql;

SELECT must_reject($$
  INSERT INTO booking (tenant_id, artist_id, venue_id, event_date, status, currency)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',
          '44444444-4444-4444-4444-444444444444','2026-09-14','confirmed','USD')
$$, 'double-booking: two confirmed shows, same venue and date');

-- The exclusion is partial: unconfirmed interest on the same date is fine.
INSERT INTO booking (id, tenant_id, artist_id, venue_id, event_date, status, currency) VALUES
  ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','2026-09-14','inquiry','USD');

INSERT INTO hold (tenant_id, booking_id, venue_id, event_date, level, status) VALUES
  ('11111111-1111-1111-1111-111111111111','77777777-7777-7777-7777-777777777777',
   '44444444-4444-4444-4444-444444444444','2026-11-02',1,'active');

SELECT must_reject($$
  INSERT INTO hold (tenant_id, booking_id, venue_id, event_date, level, status)
  VALUES ('11111111-1111-1111-1111-111111111111','77777777-7777-7777-7777-777777777777',
          '44444444-4444-4444-4444-444444444444','2026-11-02',1,'active')
$$, 'hold ladder: two active holds on the same rung');

INSERT INTO event_log (tenant_id, principal_id, operation_id, object_type, action, intent) VALUES
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   'crm_place_hold','hold','CREATE','{}');

SELECT must_reject($$UPDATE event_log SET operation_id = 'tampered'$$,
  'audit ledger: UPDATE on event_log');
SELECT must_reject($$DELETE FROM event_log$$,
  'audit ledger: DELETE on event_log');

INSERT INTO settlement (id, tenant_id, booking_id, status, settlement_currency, currency_of_record, approved_at)
VALUES ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111',
        '55555555-5555-5555-5555-555555555555','approved','USD','USD', now());

SELECT must_reject($$
  UPDATE settlement SET status='draft' WHERE id='88888888-8888-8888-8888-888888888888'
$$, 'settlement: re-opening an approved settlement');

SELECT must_reject($$
  INSERT INTO settlement_line (tenant_id, settlement_id, kind, label, amount_minor, currency)
  VALUES ('11111111-1111-1111-1111-111111111111','88888888-8888-8888-8888-888888888888',
          'expense','Late addition',100,'USD')
$$, 'settlement: adding a line after approval');

-- The amendment chain is how a legitimate correction happens instead.
INSERT INTO settlement (tenant_id, booking_id, status, settlement_currency, currency_of_record, amends_settlement_id)
VALUES ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
        'draft','USD','USD','88888888-8888-8888-8888-888888888888');

SELECT must_reject($$
  INSERT INTO agent_consent (tenant_id, user_id, agent_id, scopes)
  VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
          'tour-router', ARRAY['READ','EGRESS'])
$$, 'delegation: consent granting a non-delegable EGRESS scope');

SELECT must_reject($$
  INSERT INTO principal (tenant_id, kind, display_name)
  VALUES ('11111111-1111-1111-1111-111111111111','agent_session','Rogue Agent')
$$, 'delegation: agent_session with no on_behalf_of user');

SELECT must_reject($$
  INSERT INTO artist (tenant_id, name, kind, roster_status, commission_bps)
  VALUES ('11111111-1111-1111-1111-111111111111','Bad Deal','solo','signed',20000)
$$, 'basis points: commission above 100%');

-- RLS. A superuser bypasses row-level security silently, so the isolation
-- assertion is only meaningful under the application role.
SET LOCAL ROLE backline_app;
SET LOCAL backline.tenant_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE own_count int; other_count int;
BEGIN
  SELECT count(*) INTO own_count FROM booking;
  IF own_count = 0 THEN RAISE EXCEPTION 'FAIL  RLS: own tenant sees no rows'; END IF;
  PERFORM set_config('backline.tenant_id', '99999999-9999-9999-9999-999999999999', true);
  SELECT count(*) INTO other_count FROM booking;
  IF other_count <> 0 THEN
    RAISE EXCEPTION 'FAIL  RLS: cross-tenant read returned % rows', other_count;
  END IF;
  RAISE NOTICE 'PASS  RLS: % rows own tenant, 0 rows other tenant', own_count;
END $$;
RESET ROLE;

DO $$
BEGIN
  PERFORM assert_rls_enforced();
  RAISE EXCEPTION 'FAIL  RLS guard: did not reject a BYPASSRLS role';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS  RLS guard: refuses to serve as a BYPASSRLS role';
END $$;

ROLLBACK;
