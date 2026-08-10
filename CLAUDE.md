# CLAUDE.md — Provia

Read this file before every task. It is the constitution of this codebase. If an
instruction in a task conflicts with this file, **stop and say so** rather than
guessing.

---

## 1. What Provia is

An **asset-light, multi-service marketplace** launching in Lagos, Nigeria, built
to run unchanged in other cities and countries.

Provia owns the platform, the demand, the quality standard and the money rails.
Provia owns **no** laundromats, wash bays, cleaning crews, stores or vehicles.
Every job is delivered by an independent partner business.

Five services run on **one shared platform spine**:

| Service | Who does the work | Who moves it |
|---|---|---|
| Laundry | Partner laundromats | Partner riders |
| Car wash | Partner wash bays / mobile detailers | Optional |
| Marketplace | Partner retailers (supermarkets) | Partner riders |
| Cleaning | Partner cleaning agencies | None |
| Courier | None | Partner riders |

**Two mobile apps, not six:** `customer` and `partner`. The partner app holds
both facility mode and logistics mode on one account. Admin is web only.

---

## 2. The core architectural bet

There is one order table, one state machine, one dispatch engine, one ledger.
Each service is a **plugin** that declares only what differs.

A laundry order and a courier order are **the same row in the same table**,
differing by `service_id` and a JSONB `details` payload.

A service module declares exactly these things and nothing else:

```ts
{
  id, itemModel, pricingRules, milestones, partnerQA,
  logisticsQA, capacityUnit, vehicleRule, evidenceSpec, entitlements
}
```

**The success metric for this architecture:** service six should take about two
weeks. If you find yourself adding service-specific branching inside spine code,
you are doing it wrong — push the difference into the service module instead.

Never write `if (service === 'laundry')` in spine code. Ever.

---

## 3. Non-negotiable rules

These cost nothing to follow now and are extremely expensive to retrofit.
Breaking any of them is a blocking review failure.

1. **Money is an integer in minor units (kobo).** Never a float. Never a
   decimal. Use the `Money` type from `@provia/types`; it makes floats a type
   error.
2. **Every monetary value carries a currency code.** Never assume NGN.
3. **Every timestamp is UTC** with an explicit zone reference at the edges.
   Never assume WAT.
4. **Order state is derived from an append-only event log.** Never overwrite a
   status column. Write an event, derive state.
5. **The ledger is double-entry and immutable.** Every money movement is a
   balanced pair of entries. Escrow is a real account, not a boolean.
6. **Every money path is idempotent.** Payments, payouts, refunds and benefit
   redemptions all take an idempotency key.
7. **RLS is enabled on every table**, deny-by-default. A table without a policy
   is a public API endpoint.
8. **The `service_role` key never leaves the backend.** Not in a client, not in
   an Edge Function reachable by users, not in a build env.
9. **The server never trusts a client-supplied price.** Accept an order
   composition, recompute everything server-side.
10. **Identity is masked by default.** Partners see an order number, never a
    real name or number. Full address decrypts only when rider GPS is within
    500m.

---

## 4. Tech stack

Do not introduce anything not on this list without asking.

| Layer | Choice |
|---|---|
| Mobile | React Native + Expo, EAS Build, **EAS Update** (OTA is critical in NG) |
| Web | Next.js on Vercel |
| API | Node 22 + TypeScript + **NestJS**, deployed on Railway |
| Database | PostgreSQL via Supabase, with PostGIS |
| Auth | Supabase Auth (phone OTP primary) |
| Realtime | Supabase Realtime |
| Object storage | **Cloudflare R2** (zero egress — do not use S3) |
| Payments | Paystack |
| SMS | Termii — **account verification only** |
| Push | Expo Push |
| Maps | Mapbox for navigation only; distance/matching in PostGIS |
| Monitoring | Sentry, PostHog, Better Stack |
| CI | GitHub Actions + Turborepo |

**Explicitly not in scope yet:** Kubernetes, Kafka, microservices, Elasticsearch,
a data warehouse, GraphQL. Each has a named trigger in the scaling roadmap. If
you think one is needed, say why and stop.

---

## 5. Repo structure

```
provia/
├── apps/
│   ├── customer/        React Native · Expo — consumer app
│   ├── partner/         React Native · Expo — facility + logistics modes
│   ├── api/             NestJS modular monolith
│   └── web/             Next.js — marketing, admin console
├── packages/
│   ├── core/            service modules, state machine, pricing, QA, money
│   ├── types/           shared TS contracts — single source of truth
│   ├── ui/              design system, components, theming
│   ├── api-client/      generated typed client
│   └── config/          eslint, tsconfig, tailwind presets
├── infra/
│   ├── migrations/      versioned SQL — never edit, only add
│   └── seed/            zones, price tables, service manifests, tiers
└── .github/workflows/
```

**Module boundary rule:** `apps/*` may import from `packages/*`. `packages/*`
may not import from `apps/*`. A service module may not import another service
module.

---

## 6. Backend conventions (NestJS)

- One NestJS module per spine capability: `orders`, `dispatch`, `payments`,
  `ledger`, `partners`, `qa`, `evidence`, `entitlements`, `catalogue`.
- Modules communicate through injected services, never by reaching into another
  module's repository.
- Every state transition goes through `OrdersService.transition()`. Nothing
  writes order state directly.
- Every write that other systems care about also writes an **outbox** row in the
  same transaction.
- DTOs validated with `class-validator`. Never trust request bodies.
- Errors are typed domain errors, not thrown strings.

---

## 7. Data model rules

| Table | Rule |
|---|---|
| `orders` | Shared columns + `service_id` + `details JSONB`. No service-specific columns. |
| `order_events` | Append only. No updates, no deletes, ever. |
| `ledger_entries` | Append only, double-entry, balanced. |
| `partners` / `partner_capabilities` | One partner row, many capabilities. |
| `subscriptions` / `entitlements` | Tier definition separate from benefit grants. Values are data, not code. |
| `catalogue_items` | Marketplace only. Per-store SKU, price, availability. Full-text + trigram indexed. |
| `zones` | PostGIS polygons. Dispatch, pricing and rollout all key off zone, never city. |
| `evidence` | R2 URL + GPS + server timestamp + content hash. Binary never touches Postgres. |

Migrations are **additive only**. Never edit a shipped migration. Never drop a
column in the same release that stops writing to it.

---

## 8. Money and the ledger

Read this section twice before touching anything in `packages/core/money.ts`,
`ledger`, or `payments`.

- All amounts are `Money = { amount: number /* integer minor units */, currency: CurrencyCode }`.
- Escrow accounts: funds are held on payment, released when the customer QA
  window closes, forfeited or deducted on an upheld dispute.
- Every redemption of a membership benefit posts its cost to a
  `membership_benefit_cost` account with a `funded_by` attribution
  (`platform` | `partner` | `shared`).
- Pricing is applied in a **fixed order**, then floored:

```
base → serviceRules → commission → entitlements → promotions → enforceFloor(minMargin)
```

- Never allow an order to price below the margin floor. Discounts stack only
  within the floor.
- Paystack webhooks: **verify the HMAC signature**, then re-verify the amount
  against the Paystack API before releasing anything. Never trust the payload.

**Human review is mandatory on every PR touching money.** Say so in the PR
description if you touched it.

---

## 9. Security

- RLS deny-by-default on every table. CI fails the build if a table has no policy.
- Test Realtime subscriptions as an attacker: a permissive policy on `orders`
  means anyone can subscribe to every order on the platform.
- Handoff codes: single-use, bound to a specific order **and** actor, short
  expiry, locked after 3 failed attempts with the order frozen for ops review.
- Bank-detail changes on a partner account: re-verification, 24–48h payout
  freeze, notify the **previous** contact channel.
- Addresses encrypted at rest. Every decryption logged and rate-limited.
- The mobile apps hold **no secret** beyond the Supabase anon key.
- Rate limit every endpoint that costs money downstream (maps, SMS, uploads),
  and set hard spend caps.

---

## 10. The order lifecycle

The spine is a configurable milestone sequence. Laundry is the reference
implementation and has the longest chain:

```
0  Order placed and paid
1  Rider assigned
2  Rider en route to customer
3  Rider at customer            → ACTION: two-code pickup
4  Items collected and sealed
5  Delivered to facility partner → partner code handshake
6  Partner working
7  Partner QA passed
8  Rider verified QA and collected
9  Out for delivery
10 Rider at customer            → ACTION: delivery code
11 Delivered, 24-hour QA window open
12 Complete, escrow released
```

Courier drops milestones 5–8. Cleaning and car wash have no logistics leg.
Marketplace replaces the facility leg with a shopping and substitution leg.

**Never hardcode this sequence.** It comes from the service module.

---

## 11. The three-code handshake

This is the trust backbone of the product. Get it exactly right.

| Code | Who displays | Who enters | What it proves |
|---|---|---|---|
| 1 · Identity | Customer | Rider | This order belongs to this customer (riders carry several) |
| 2 · Release | Customer | Rider | The count is agreed; bag is sealed and count locked |
| 3 · Facility | Partner | Rider | What was picked up is what arrived; QA responsibility transfers |
| 4 · Delivery | Customer | Rider | Handover confirmed; 24-hour QA window opens |

Between code 1 and code 2 sits the **count verification** step. The rider sees
what the customer *declared* — read-only. They do not re-count from scratch.
Only on discrepancy does an edit mode appear, and an overage requires customer
approval and payment before code 2 can be released.

---

## 12. The QA model

Three independent layers. Never collapse them.

1. **Partner QA** — a service-specific checklist (7 points for laundry). All must
   pass before completion photos unlock.
2. **Rider QA on collection** — 5 points. Earns the rider a bonus when it passes
   first time.
3. **Customer QA window** — 24 hours after delivery to raise anything, with the
   full photo evidence chain on file.

Scoring: pass first time = full credit, redo = 70%, second redo = 40%, upheld
dispute = 0% plus a refund charge. Warning at 85%, suspension at 70%.

---

## 13. Matching and dispatch

Assignment is a **weighted score**, not "nearest available":

QA score · specialisation match · live capacity · SLA reliability · zone
distance · price tier · **fairness rotation for newer partners**.

Customers express *preferences* ("prefer premium", "specialist in native wear"),
never a named partner. This is deliberate — named-partner loyalty causes supply
concentration and disintermediation. Do not add a "choose your laundromat"
feature.

---

## 14. Mobile app conventions

- **Portrait locked, both apps.** No landscape layouts.
- **Offline tolerant.** Item counts, checklists and photos persist locally and
  sync on reconnect. Losing a partner's work to a dropped signal is unacceptable.
- **Photos compressed on device** to ~300KB, uploaded direct to R2 via presigned
  URL. The API never handles image bytes.
- **Performance target is a low-end Android on 3G**, not a flagship on fibre.
- Bottom navigation is present on **every** in-app screen.
- Leaving a partially-built order requires a confirmation sheet.
- **Never show the customer the word "escrow."** Say "you are not charged until
  your rider has counted everything."

---

## 15. Design system

Tokens live in `packages/ui`. Never hardcode a colour.

```
Forest    #1B5E42     primary actions
Forest-hi #237552     gradient partner
Accent    #1F7A57 light / #5EC4A0 dark
Gold      #8A6C22 light / #D9BC7A dark — all monetary values
Red       #C0483C     destructive only
Amber     #9A7318     warnings, SLA pressure
Ink       #0F1D16 / Ink2 #4E6459 / Ink3 #87998F
```

- **Light mode is the default.** Both themes must work; test both.
- Type: **Sora** for UI, **Instrument Serif italic** for headings and greetings.
- Radii: 14px controls, 18px cards, 44px device frame.
- Motion: 0.36s `cubic-bezier(.32,.72,.24,1)` screen transitions, `scale(.97)` on
  tap. Respect `prefers-reduced-motion`.
- Every monetary figure is gold. Every destructive action is red and confirmed.

---

## 16. Copy voice

- Plain, calm, specific. Short sentences.
- British English spelling.
- Never jargon at the customer: no "escrow", no "SLA", no "QA layer".
- Say what happens next, not what the system did.
- Prices are always shown honestly. **Never label a paid thing "Free."**
- Good: *"You are not charged until your rider has counted everything."*
- Bad: *"Funds held in escrow pending fulfilment confirmation."*

---

## 17. Testing policy

Not a coverage target. Ruthless where it matters, light elsewhere.

**Must have tests:**
- State machine — every legal and illegal transition
- Pricing engine — every rule, every stacking order, the margin floor
- Ledger — balance invariants, idempotency, escrow release and forfeit
- Entitlements — caps, eligibility, funding attribution
- Handoff codes — expiry, single use, lockout, wrong-actor rejection

**Light tests:** UI components, CRUD endpoints, admin screens.

Every bug fix ships with a regression test reproducing it.

---

## 18. Definition of done

A task is not done until:

1. TypeScript compiles with no errors and no new `any`
2. Lint passes
3. Tests pass, and new tests exist if section 17 applies
4. Both light and dark themes verified if UI
5. RLS policy exists if a table was added
6. A migration exists and is additive if the schema changed
7. Nothing in section 3 was violated
8. The PR description names anything touching money, auth or personal data

---

## 19. Never do this

- Never write service-specific branching in spine code
- Never store money as a float or without a currency
- Never mutate order state in place
- Never trust a client-supplied price, total or entitlement
- Never put a secret in a mobile app or a repo
- Never create a table without an RLS policy
- Never edit a shipped migration
- Never call an external maps API on every dispatch
- Never send a handoff code by SMS (they display in-app; this is a cost decision)
- Never build a "choose your partner" feature
- Never show internal vocabulary to a customer

---

## 20. When to stop and ask

Stop and ask rather than guessing when:

- A task would require breaking any rule in section 3 or 19
- A task requires a dependency not listed in section 4
- The correct behaviour of a money or QA rule is ambiguous
- A schema change would be destructive rather than additive
- You are about to write the same logic in two service modules — that means it
  belongs in the spine instead

Ambiguity is cheap to resolve before code and expensive after.
