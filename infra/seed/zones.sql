-- ============================================================================
-- infra/seed/zones.sql
-- Provia — zone seed data
--
-- CLAUDE.md §1 — launching in Lagos, Nigeria; built to run unchanged
-- elsewhere. Lagos is the first zone for exactly that reason.
-- CLAUDE.md §7 — dispatch, pricing and rollout all key off zone, never
-- city; a zone row is the unit every one of those systems reads.
--
-- This is seed data, not a migration: safe to re-run, safe to edit in
-- place (infra/migrations/0001_foundation.sql's "never edit, only add"
-- rule applies to shipped schema changes, not to this file).
--
-- This row already existed in the local Supabase instance before this
-- file was written — seeded ad hoc during an earlier attack-suite
-- verification pass, with no committed record of it anywhere in the
-- repo. That undocumented state was the actual gap this file closes.
-- The values below were read directly off the live row with a
-- verification query and are transcribed exactly, not invented:
--
--   id            | 11111111-1111-1111-1111-111111111111
--   name          | Ikeja Test Zone
--   city          | Lagos
--   country_code  | NG
--   is_active     | true
--   boundary      | POLYGON((3.3 6.55, 3.4 6.55, 3.4 6.65, 3.3 6.65, 3.3 6.55))
--
-- The `on conflict` clause is a true no-op against that existing row —
-- every excluded.* value below matches what's already there, so running
-- this against the live database changes nothing. It exists so a fresh
-- database (a new dev environment, CI, a rebuilt local instance) ends up
-- with the same zone this id has always meant, instead of a foreign key
-- violation the first time an order references it.
--
-- apps/customer/src/api/placeOrderPilotStub.ts's PILOT_ZONE_ID must match
-- this id exactly — if this id ever changes, update that constant in the
-- same change, or pilot order creation fails with a foreign key
-- violation against orders.zone_id.
-- ============================================================================

insert into public.zones (id, name, city, country_code, boundary, is_active)
values (
  '11111111-1111-1111-1111-111111111111',
  'Ikeja Test Zone',
  'Lagos',
  'NG',
  ST_GeogFromText('SRID=4326;POLYGON((3.3 6.55, 3.4 6.55, 3.4 6.65, 3.3 6.65, 3.3 6.55))'),
  true
)
on conflict (id) do update set
  name         = excluded.name,
  city         = excluded.city,
  country_code = excluded.country_code,
  boundary     = excluded.boundary,
  is_active    = excluded.is_active;
