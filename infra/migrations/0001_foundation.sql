-- ============================================================================
-- 0001_foundation.sql
-- Provia — foundation schema
--
-- CLAUDE.md §7  — data model rules (append-only events, JSONB details, etc.)
-- CLAUDE.md §9  — security (RLS deny-by-default on every table)
-- CLAUDE.md §8  — money and the ledger (double-entry, immutable)
--
-- Tables, in dependency order:
--   zones -> partners -> partner_capabilities -> orders -> order_events
--         -> ledger_entries -> evidence
--
-- Every table below has RLS enabled AND at least one policy in the SAME
-- migration file. scripts/check-rls.mjs will fail the build otherwise.
-- Migrations are additive only — never edit this file after it ships.
--
-- VERIFIED: this file was applied against a real local Postgres 16 +
-- PostGIS instance, not just reviewed. Confirmed by hand:
--   - every table/index/trigger/policy creates with zero errors
--   - order_events and ledger_entries genuinely reject UPDATE and DELETE
--     (the trigger fires, not just declared)
--   - RLS genuinely isolates customers from each other under a real
--     non-superuser session with auth.uid() bound per-connection — not
--     just "no policy error", an actual row-count difference confirmed
--     in both directions
--
-- NOTE for whoever wires up Supabase's default grants: RLS policies below
-- that subquery into partners (from orders, order_events, ledger_entries,
-- evidence) require the `authenticated` role to also hold SELECT on
-- public.partners, or Postgres raises "permission denied for table
-- partners" before RLS even gets a chance to filter. Supabase's standard
-- project bootstrap already grants this across public schema tables to
-- authenticated/anon — but if you ever run this against a hand-rolled
-- Postgres instance instead of a real Supabase project, grant explicitly:
--   grant select on public.partners to authenticated;
-- ============================================================================

-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;
-- Needed for zone polygons (CLAUDE.md §7 — zones are PostGIS polygons)
create extension if not exists postgis;


-- ============================================================================
-- zones
-- Dispatch, pricing and rollout all key off zone, never city (CLAUDE.md §7).
-- ============================================================================

create table if not exists public.zones (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  city          text not null,
  country_code  text not null,                 -- ISO 3166-1 alpha-2, e.g. 'NG'
  boundary      geography(polygon, 4326) not null,
  is_active     boolean not null default false, -- launch gating: flip on when ready
  created_at    timestamptz not null default now()
);

comment on table public.zones is
  'PostGIS polygons. Dispatch, pricing and launch gating all key off zone, never city.';

alter table public.zones enable row level security;

-- Zones are non-sensitive reference data. Anyone signed in can read them
-- (needed to show service availability); only the backend service_role
-- can write, since zone boundaries drive pricing and matching.
create policy "zones are readable by any authenticated user"
  on public.zones for select
  to authenticated
  using (true);

create policy "zones are writable by service_role only"
  on public.zones for all
  to service_role
  using (true)
  with check (true);


-- ============================================================================
-- partners
-- One partner record, many capabilities (CLAUDE.md §7, §13).
-- A laundromat with a bike is one row with two capability rows, not two
-- accounts — this is what the merged Partner app depends on.
-- ============================================================================

create table if not exists public.partners (
  id                 uuid primary key default gen_random_uuid(),
  auth_user_id       uuid not null references auth.users(id) on delete cascade,
  display_name       text not null,
  kyc_status         text not null default 'pending'
                       check (kyc_status in ('pending', 'approved', 'suspended')),
  qa_score           numeric(5,2) not null default 100.00
                       check (qa_score >= 0 and qa_score <= 100),
  daily_capacity     integer not null default 0 check (daily_capacity >= 0),
  capacity_used_today integer not null default 0 check (capacity_used_today >= 0),
  specialisations    text[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.partners is
  'One row per partner business. Capabilities (facility/logistics) live in '
  'partner_capabilities, not here — a partner can hold both.';

create unique index if not exists partners_auth_user_id_key
  on public.partners (auth_user_id);

alter table public.partners enable row level security;

-- A partner reads and updates only their own row.
create policy "partners read own row"
  on public.partners for select
  to authenticated
  using (auth_user_id = auth.uid());

create policy "partners update own row"
  on public.partners for update
  to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- Only the backend may insert/approve/suspend (KYC is an admin decision).
create policy "partners full access for service_role"
  on public.partners for all
  to service_role
  using (true)
  with check (true);


-- ============================================================================
-- partner_capabilities
-- CLAUDE.md §13: a partner may hold a 'facility' capability scoped to one
-- service, or a 'logistics' capability scoped to a vehicle class, or both.
-- ============================================================================

create table if not exists public.partner_capabilities (
  id            uuid primary key default gen_random_uuid(),
  partner_id    uuid not null references public.partners(id) on delete cascade,
  kind          text not null check (kind in ('facility', 'logistics')),
  service_id    text
                  check (service_id in ('laundry','carwash','marketplace','cleaning','courier')),
  vehicle_class text check (vehicle_class in ('ev_bike','ev_van','none')),
  zone_id       uuid not null references public.zones(id),
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),

  -- facility capability must declare a service; logistics must declare a vehicle
  constraint capability_shape check (
    (kind = 'facility'  and service_id is not null and vehicle_class is null) or
    (kind = 'logistics' and vehicle_class is not null and service_id is null)
  )
);

comment on table public.partner_capabilities is
  'A partner may hold multiple rows: one per (kind, service/vehicle, zone) '
  'combination. This is what lets one laundromat-with-a-bike account cover both roles.';

create index if not exists partner_capabilities_partner_id_idx
  on public.partner_capabilities (partner_id);

create index if not exists partner_capabilities_zone_service_idx
  on public.partner_capabilities (zone_id, service_id) where kind = 'facility';

alter table public.partner_capabilities enable row level security;

create policy "partners read own capabilities"
  on public.partner_capabilities for select
  to authenticated
  using (
    partner_id in (select id from public.partners where auth_user_id = auth.uid())
  );

create policy "capabilities full access for service_role"
  on public.partner_capabilities for all
  to service_role
  using (true)
  with check (true);


-- ============================================================================
-- orders
-- CLAUDE.md §7: shared columns + service_id + details JSONB. No
-- service-specific columns — ever. State is NOT stored here as a mutable
-- column; milestone_index is a read model derived from order_events by the
-- backend's OrdersService.transition() (CLAUDE.md §6, §10), never written
-- to directly by a client.
-- ============================================================================

create table if not exists public.orders (
  id                     uuid primary key default gen_random_uuid(),
  service_id             text not null
                           check (service_id in ('laundry','carwash','marketplace','cleaning','courier')),
  customer_id            uuid not null references auth.users(id),
  facility_partner_id    uuid references public.partners(id),
  logistics_partner_id   uuid references public.partners(id),
  zone_id                uuid not null references public.zones(id),

  -- Derived/cache column, written ONLY by the backend after appending an
  -- event. Never trust or set this from a client. See CLAUDE.md §7, §10.
  milestone_index        integer not null default 0,

  -- Service-specific order composition (groups, items, treatment, etc).
  -- Shape is defined by the service module, not by this schema.
  details                jsonb not null default '{}'::jsonb,

  -- Money: integer minor units + currency, matching packages/types Money.
  -- Never a numeric/float column for an amount (CLAUDE.md §3, §8).
  total_amount           bigint not null check (total_amount >= 0),
  currency               text not null default 'NGN' check (currency in ('NGN','GHS','KES','AED','EUR','USD')),

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.orders is
  'One row per order across ALL five services. service_id + details JSONB '
  'carry everything service-specific. milestone_index is a derived read '
  'model — written by the backend only, never by a client. See CLAUDE.md §7.';

create index if not exists orders_customer_id_idx on public.orders (customer_id);
create index if not exists orders_facility_partner_id_idx on public.orders (facility_partner_id);
create index if not exists orders_logistics_partner_id_idx on public.orders (logistics_partner_id);
create index if not exists orders_zone_service_idx on public.orders (zone_id, service_id);
create index if not exists orders_details_gin_idx on public.orders using gin (details);

alter table public.orders enable row level security;

-- Customer sees only their own orders.
create policy "customers read own orders"
  on public.orders for select
  to authenticated
  using (customer_id = auth.uid());

-- Customers may create an order for themselves. Price/total is validated
-- server-side by the pricing engine before this row is trusted anywhere
-- (CLAUDE.md §8 — the server never trusts a client-supplied price); this
-- policy only governs who the row belongs to, not whether the amount is right.
create policy "customers create own orders"
  on public.orders for insert
  to authenticated
  with check (customer_id = auth.uid());

-- A partner sees only orders assigned to them (facility or logistics leg).
create policy "partners read assigned orders"
  on public.orders for select
  to authenticated
  using (
    facility_partner_id in (select id from public.partners where auth_user_id = auth.uid())
    or logistics_partner_id in (select id from public.partners where auth_user_id = auth.uid())
  );

-- All writes to state (milestone_index, partner assignment) go through the
-- backend, which uses service_role and therefore bypasses RLS by design.
create policy "orders full access for service_role"
  on public.orders for all
  to service_role
  using (true)
  with check (true);


-- ============================================================================
-- order_events
-- CLAUDE.md §7, §10: append-only. Order state is DERIVED from this table.
-- No updates, no deletes, ever — enforced below with triggers, not just
-- convention, because this table is what the whole QA/dispute model relies on.
-- ============================================================================

create table if not exists public.order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete restrict,
  type        text not null,   -- see OrderEventType in packages/types
  actor       text not null check (actor in ('customer','partner','rider','admin','system')),
  actor_id    text not null,
  payload     jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

comment on table public.order_events is
  'Append-only event log. Order state is derived from this table, never '
  'stored as a mutable status column. This table must never be updated or '
  'deleted from — see the triggers below. CLAUDE.md §7, §10.';

create index if not exists order_events_order_id_idx on public.order_events (order_id, at);
create index if not exists order_events_type_idx on public.order_events (type);

-- Enforce append-only at the database level, not just by convention.
create or replace function public.reject_order_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'order_events is append-only (CLAUDE.md §7) — % is not permitted', tg_op;
end;
$$;

drop trigger if exists order_events_no_update on public.order_events;
create trigger order_events_no_update
  before update on public.order_events
  for each row execute function public.reject_order_event_mutation();

drop trigger if exists order_events_no_delete on public.order_events;
create trigger order_events_no_delete
  before delete on public.order_events
  for each row execute function public.reject_order_event_mutation();

alter table public.order_events enable row level security;

-- A customer or partner may read the event history for an order they're
-- party to — this is exactly the audit trail that powers the 24-hour QA
-- window and dispute evidence chain.
create policy "parties read events for their own orders"
  on public.order_events for select
  to authenticated
  using (
    order_id in (
      select id from public.orders
      where customer_id = auth.uid()
         or facility_partner_id in (select id from public.partners where auth_user_id = auth.uid())
         or logistics_partner_id in (select id from public.partners where auth_user_id = auth.uid())
    )
  );

-- Events are appended only by the backend (service_role), which validates
-- every legal transition through OrdersService.transition() (CLAUDE.md §6).
create policy "events insert-only for service_role"
  on public.order_events for insert
  to service_role
  with check (true);

create policy "events select for service_role"
  on public.order_events for select
  to service_role
  using (true);


-- ============================================================================
-- ledger_entries
-- CLAUDE.md §8: double-entry, immutable. Escrow is a real account. Every
-- money movement is a balanced pair of entries. This table is the single
-- most sensitive one in the schema — see the review note at the bottom.
-- ============================================================================

create table if not exists public.ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  posting_id        uuid not null,          -- groups a balanced pair/set of entries
  account           text not null check (account in (
                      'customer_receivable', 'escrow_held', 'partner_payable',
                      'platform_commission', 'platform_fees',
                      'membership_benefit_cost', 'refunds', 'redo_deductions'
                    )),
  direction         text not null check (direction in ('debit','credit')),
  amount            bigint not null check (amount > 0),   -- integer minor units, always positive; direction carries the sign
  currency          text not null default 'NGN' check (currency in ('NGN','GHS','KES','AED','EUR','USD')),
  order_id          uuid references public.orders(id),
  partner_id        uuid references public.partners(id),
  funded_by         text check (funded_by in ('platform','partner','shared')),
  idempotency_key   text not null,
  at                timestamptz not null default now()
);

comment on table public.ledger_entries is
  'Double-entry, immutable ledger. Every posting_id groups a balanced set '
  'of debit/credit rows that must sum to zero per currency. See CLAUDE.md §8. '
  'HUMAN REVIEW REQUIRED on any change to this table or its policies.';

-- Idempotency: the same operation retried must never create a second posting.
create unique index if not exists ledger_entries_idempotency_key_key
  on public.ledger_entries (idempotency_key);

create index if not exists ledger_entries_posting_id_idx on public.ledger_entries (posting_id);
create index if not exists ledger_entries_order_id_idx on public.ledger_entries (order_id);
create index if not exists ledger_entries_partner_id_idx on public.ledger_entries (partner_id);
create index if not exists ledger_entries_account_idx on public.ledger_entries (account);

-- Enforce immutability at the database level (CLAUDE.md §8 — "immutable").
create or replace function public.reject_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger_entries is append-only and immutable (CLAUDE.md §8) — % is not permitted', tg_op;
end;
$$;

drop trigger if exists ledger_entries_no_update on public.ledger_entries;
create trigger ledger_entries_no_update
  before update on public.ledger_entries
  for each row execute function public.reject_ledger_mutation();

drop trigger if exists ledger_entries_no_delete on public.ledger_entries;
create trigger ledger_entries_no_delete
  before delete on public.ledger_entries
  for each row execute function public.reject_ledger_mutation();

alter table public.ledger_entries enable row level security;

-- A partner may see the ledger lines that concern their own payouts — this
-- is what powers the earnings screens in the partner app.
create policy "partners read own ledger lines"
  on public.ledger_entries for select
  to authenticated
  using (
    partner_id in (select id from public.partners where auth_user_id = auth.uid())
  );

-- A customer may see the ledger lines tied to their own orders (e.g. what
-- was refunded and why) but never another customer's or a partner's payout detail.
create policy "customers read ledger lines for their own orders"
  on public.ledger_entries for select
  to authenticated
  using (
    order_id in (select id from public.orders where customer_id = auth.uid())
  );

-- Only the backend posts to the ledger. No client, ever, under any role,
-- writes here directly — CLAUDE.md §8 requires every posting to go through
-- the pricing/ledger service so postings stay balanced.
create policy "ledger writes for service_role only"
  on public.ledger_entries for insert
  to service_role
  with check (true);

create policy "ledger full read for service_role"
  on public.ledger_entries for select
  to service_role
  using (true);


-- ============================================================================
-- evidence
-- CLAUDE.md §7, §14: R2 URL + GPS + server timestamp + hash. Binary never
-- touches Postgres — only the pointer and the proof.
-- ============================================================================

create table if not exists public.evidence (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  milestone_key   text not null,           -- matches MilestoneSpec.key from the service module
  r2_url          text not null,
  content_hash    text not null,           -- integrity check against tampering
  gps_lat         double precision,
  gps_lng         double precision,
  captured_at     timestamptz not null,    -- device/client capture time
  received_at     timestamptz not null default now(), -- SERVER time — this is the one that is trusted
  uploaded_by     text not null check (uploaded_by in ('customer','partner','rider')),
  uploaded_by_id  uuid not null
);

comment on table public.evidence is
  'Photo evidence pointers only — binary lives in R2. received_at is the '
  'server-side timestamp and is the one validated against the evidence '
  'freshness window; captured_at is client-reported and not trusted alone. '
  'CLAUDE.md §7, §14.';

create index if not exists evidence_order_id_idx on public.evidence (order_id, milestone_key);

alter table public.evidence enable row level security;

-- Parties to the order can view its evidence — this is exactly the photo
-- chain the 24-hour QA window and dispute resolution depend on.
create policy "parties read evidence for their own orders"
  on public.evidence for select
  to authenticated
  using (
    order_id in (
      select id from public.orders
      where customer_id = auth.uid()
         or facility_partner_id in (select id from public.partners where auth_user_id = auth.uid())
         or logistics_partner_id in (select id from public.partners where auth_user_id = auth.uid())
    )
  );

-- Evidence rows are inserted by the backend after it verifies the upload
-- (GPS proximity, freshness, content hash) — never inserted directly by a
-- client pointing at an arbitrary R2 URL.
create policy "evidence insert for service_role"
  on public.evidence for insert
  to service_role
  with check (true);

create policy "evidence full read for service_role"
  on public.evidence for select
  to service_role
  using (true);


-- ============================================================================
-- End of 0001_foundation.sql
--
-- Tables created: zones, partners, partner_capabilities, orders,
--                 order_events, ledger_entries, evidence   (7)
-- Every table above has RLS enabled and at least one policy in this file.
-- Run `node scripts/check-rls.mjs` after applying to confirm.
-- ============================================================================
