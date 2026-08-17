-- ============================================================================
-- infra/migrations/0002_handoff_codes.sql
-- Provia — handoff codes: the three/four-code trust mechanism
--
-- CLAUDE.md §11 — the three-code handshake is the trust backbone of the
-- product. This table is its real, production implementation, not a pilot
-- shortcut — the same design serves one partner or five hundred.
--
-- Codes are 4 digits, matching the existing customer/partner app UI design.
-- Security here comes from short-lived, single-use tokens with a hard
-- attempt limit — the same class of protection as a bank card PIN — not
-- from code length.
--
-- A code is generated server-side, inside the SAME transaction as the
-- milestone event that requires it (see OrdersService.transition() in
-- apps/api/src/orders/orders.service.ts), so a code-requiring milestone
-- and its code always exist atomically together. Nothing outside that
-- transaction ever inserts a row here.
-- ============================================================================

create table if not exists public.handoff_codes (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,

  -- Matches HandoffCodeKind in packages/types/src/index.ts exactly.
  kind               text not null check (kind in ('identity', 'release', 'facility', 'delivery')),

  -- 4 digits, stored as text to preserve leading zeros (e.g. "0042").
  code               text not null check (code ~ '^[0-9]{4}$'),

  -- Who is allowed to ENTER this code (checked in application code against
  -- the requester's resolved role, same pattern AuthGuard already
  -- establishes for request.userId/request.userRole).
  entered_by         text not null check (entered_by in ('partner_logistics', 'partner_facility')),

  expires_at         timestamptz not null,
  attempts_remaining integer not null default 3 check (attempts_remaining >= 0),
  consumed_at        timestamptz,

  created_at         timestamptz not null default now()
);

comment on table public.handoff_codes is
  'The real handoff-code mechanism (CLAUDE.md §11). One row per code, '
  'generated atomically alongside the milestone event that requires it. '
  'Never updated except to decrement attempts_remaining or set consumed_at '
  '— there is no "regenerate" path; a locked-out code becomes a dispute, '
  'not a retry.';

-- An order may have multiple codes over its life (identity, release,
-- facility, delivery) but never two ACTIVE codes of the same kind at once.
create unique index if not exists handoff_codes_order_kind_active_idx
  on public.handoff_codes (order_id, kind)
  where consumed_at is null;

create index if not exists handoff_codes_order_id_idx on public.handoff_codes (order_id);

alter table public.handoff_codes enable row level security;

-- ── Read policies: exactly who is allowed to SEE the raw code value ──
--
-- identity/release/delivery codes are displayed by the CUSTOMER.
-- facility codes are displayed by the FACILITY PARTNER.
-- The rider/logistics partner who ENTERS a code never has a read policy
-- here at all — they receive it verbally/visually from whoever displays
-- it, never by querying this table. This is the actual security property:
-- even a compromised rider account cannot list codes ahead of time.

create policy "customers read their own order's non-facility codes"
  on public.handoff_codes for select
  to authenticated
  using (
    kind in ('identity', 'release', 'delivery')
    and order_id in (select id from public.orders where customer_id = auth.uid())
  );

create policy "facility partners read their own order's facility code"
  on public.handoff_codes for select
  to authenticated
  using (
    kind = 'facility'
    and order_id in (
      select id from public.orders
      where facility_partner_id in (select id from public.partners where auth_user_id = auth.uid())
    )
  );

-- All writes (generation, attempt decrement, consumption) go through the
-- backend under service_role, inside OrdersService's transaction — never
-- direct from a client, matching the ledger's own write discipline.
create policy "handoff_codes full access for service_role"
  on public.handoff_codes for all
  to service_role
  using (true)
  with check (true);

-- ============================================================================
-- End of 0002_handoff_codes.sql
-- Run `node scripts/check-rls.mjs` after applying — expect 8 tables now.
-- ============================================================================
