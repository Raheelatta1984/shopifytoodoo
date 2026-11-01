# Architecture

## 1. Components

```
┌────────────────┐   GraphQL Admin API (2026-07)   ┌─────────────────────┐
│    Shopify     │ ───────────────────────────────► │  Ingestion service  │
│    Admin API   │                                  │  (src/services/     │
└────────────────┘                                  │   ingestion-service)│
                                                     └──────────┬──────────┘
                                                                │ canonical order
                                                                ▼
┌────────────────┐        ┌───────────────────────────────────────────────┐
│  Odoo 19       │ ◄───── │            Publishing service                 │
│  sale.order    │ xmlrpc │  (src/services/publish-service.ts)            │
│  sale.order.   │ jsonrpc│  · validation gate                            │
│  line          │        │  · approval gate                             │
│  stock.picking │        │  · payload builder (src/domain/odoo-mapper)  │
│  res.partner   │        │  · DMF generator   (src/domain/dmf.ts)      │
└────────────────┘        └──────────────────────┬────────────────────────┘
                                                │ read / write
                                                ▼
                                   ┌────────────────────────────┐
                                   │  Central order tables      │
                                   │  (Postgres / Neon)         │
                                   │  sales_order_head / _line  │
                                   │  sales_order_discount      │
                                   │  sales_order_transaction   │
                                   │  audit_log, mappings, …    │
                                   └────────────────────────────┘
```

| Layer | Folder | Responsibility |
|---|---|---|
| Domain | `src/domain` | money, canonical model, validation rules, Odoo payload, DMF |
| Integrations | `src/integrations` | Shopify GraphQL client + mapper, Odoo XML-RPC/JSON-RPC client + XML codec |
| Persistence | `src/repositories`, `src/db` | SQL over a tiny `Db` interface (Postgres **and** embedded PGlite) |
| Services | `src/services` | ingestion, validation, approval, publishing, Odoo gateway |
| Interface | `src/routes`, `src/app.ts` | HTTP API, RBAC, audit |
| Operations | `src/cli` | `sync`, `seed`, `migrate`, `schema:dump` |

## 2. The canonical model

`src/domain/types.ts` defines the source agnostic order model.  It is the
contract between the ingestion, the storage, the validation and the publishing
layers.

* Every monetary value is an **integer in the minor unit** of the currency
  (`src/domain/money.ts`).  `toMinor('12.34', 'AUD') === 1234`.  The currency
  exponent is honoured (JPY = 0, KWD = 3), so no floating point rounding can
  creep into the totals.
* `CanonicalOrder.computed` holds the amounts rebuilt from the components
  (lines, shipping, discounts, tax); the head holds the amounts **reported by
  Shopify**.  The validation rules compare the two, which is how a "100 %
  download" is proven instead of assumed.
* `CanonicalLine.allocations` keeps the discount allocation of every line so
  that the discount can be reported line by line in Odoo.

## 3. Discounts

Shopify describes the *intent* of a discount (`discountApplications`) and the
*money* that was deducted (`discountAllocations`).  The mapper uses the
allocations as the source of truth:

1. every line allocation is summed into `line.discountTotal`;
2. every shipping allocation is summed into `shippingDiscountTotal`;
3. an order level discount that has **no** allocation (an "entire order"
   discount) is derived from its value and spread over the lines with the
   largest remainder method, so the sum is exactly the discount amount;
4. the discount records keep the code, the allocation method, the target type
   and the value (amount or percentage).

`VAL-003` accepts the two readings Shopify uses for the order level discount
total (with or without the shipping discount).

## 4. Pricing in Odoo

`src/domain/odoo-mapper.ts` computes, for every line:

* **percentage** — Odoo's native `discount` field with the list price.  Used
  when the percentage reproduces the Shopify amount to the cent, because the
  discount then stays visible in Odoo.
* **net price** — the discounted unit price is written directly.  Used when a
  two decimal percentage cannot reproduce the amount exactly.

The extended prices are then reconciled against the Shopify net total; a
residual of a few cents is distributed over the lines so that the Odoo sales
order carries exactly the same money as the shop order.

Shipping is not a sale order line: it is carried in the order note and in the
central tables (`sales_order_head.shipping_lines`) so that it can be reviewed
before the order is accepted.

## 5. The publish gate

```
publish(order)
  ├─ already published?            → skipped (idempotent)
  ├─ validation fails?             → failed (nothing is sent to Odoo)
  ├─ approval missing?             → failed (nothing is sent to Odoo)
  ├─ method = dmf                  → artefacts + optional base_import upload
  └─ method = xmlrpc / jsonrpc     → partner → sale.order.create → confirm → pickings
```

The gate is enforced in `src/services/publish-service.ts`; the same code is
used by the HTTP API and by the CLI, so there is a single place where the
"validate → approve → publish" contract lives.

## 6. Roles

| Role | May do |
|---|---|
| `viewer` | read the orders |
| `operator` | download, validate, publish, reject |
| `approver` | validate, approve, reject, publish |
| `integrator` | download, validate, publish, manage the mappings |
| `auditor` | read the audit trail |
| `admin` | everything, including the settings and the users |

The API keys are stored as a SHA-256 hash (`app_user.api_key_hash`); the
plain text key is never written to the database.  Every mutating endpoint
declares the permission it requires and every call is written to `audit_log`.

## 7. Datastore

The `Db` interface (`src/db/types.ts`) is implemented twice:

* `PostgresDb` — a pooled `pg` client.  Neon is supported out of the box: TLS
  is enabled automatically for `*.neon.tech` hosts and `prepare: false` is set
  for the transaction pooler.
* `PGliteDb` — an embedded Postgres (WASM).  It speaks the same dialect, so
  the migrations and the queries behave identically.  It is used for the
  local development, the CI and the air-gapped demo.

Both support `transaction(fn)`, so the ingestion is atomic: the head, the
lines, the discounts and the transactions are written together or not at all.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| Shopify unreachable / GraphQL error | the ingestion is aborted, the error is audited, nothing is partially stored |
| A single order cannot be mapped | the order is counted as failed, the other orders continue |
| Validation failure | the order is marked `downloaded` with `validation_status = failed`; the failing rules are stored |
| Approval missing | the publish returns `failed` with the reason; nothing is sent to Odoo |
| Odoo error | the attempt is recorded with the request, the response and the error; the order is marked `failed` |
| Odoo does not know the `x_shopify_*` fields | the creation is retried without them (the addon is optional) |
| Odoo already has the order | the existing sale order is reused (the client order reference is the key) |

## 9. Security notes

* The API keys are hashed; the plain text key only exists in the environment.
* The audit trail records the actor, the role, the action, the entity, the
  result and the IP address.
* PII (the customer name, the email, the phone and the addresses) is stored
  in the central tables because the sales order needs it; the retention
  policy is an operational decision and is documented in the runbook.
* The service never writes credentials to the database, the logs or the
  generated artefacts; the DMF manifest only contains business data.
