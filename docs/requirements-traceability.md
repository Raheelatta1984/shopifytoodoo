# Requirements traceability

Engagement **ENG-D3C8B563** — "Shopify Orders to download into Odoo 19 test
plan", revision 91.

The requirement and evidence identifiers of the reviewed handoff are preserved
here and are referenced from the code (the validation rules carry the
`REQ-…` / `EV-…` identifiers in their `requirement` field).

## 1. Requirement register

| ID | Requirement area | How it is implemented | Where | Tests |
|---|---|---|---|---|
| REQ-001 | Business context | The solution is the middleware between Shopify and Odoo: the shop order is downloaded, kept in the central tables and published to Odoo without an operator copying data by hand. | `src/services/ingestion-service.ts`, `src/services/publish-service.ts` | `tests/integration/pipeline.test.ts` |
| REQ-002 | Problem & evidence | The download, the validation and the publish are three explicit, automated steps; the picking information is read back from Odoo into `sales_order_picking`. | `src/services/*`, `src/services/odoo-gateway.ts` | `tests/integration/pipeline.test.ts` |
| REQ-003 | People & ownership | Every action is attributed to a named user with a role; the customer and the fulfilment information are carried with the order for the e-commerce and customer service teams. | `src/security/auth.ts`, `audit_log` | `tests/integration/api.test.ts` |
| REQ-004 | Outcomes & measures | The processing time is observable: `downloaded_at`, `approved_at`, the publish attempts and the audit trail give the duration of every step. | `sales_order_head`, `publish_attempt`, `audit_log` | `tests/integration/pipeline.test.ts` |
| REQ-005 | Scope & boundaries | The core workflow only: download → validate → approve → publish. The 13 rules prove that the order was downloaded 100 % before it is accepted. | `src/domain/validation.ts` | `tests/unit/validation.test.ts`, `tests/integration/pipeline.test.ts` |
| REQ-006 | Functional needs | The current status and the next action are exposed on the order (`status`, `validationStatus`, `approvalStatus`); the approval depends on a configurable threshold and on the role. | `src/routes/orders.ts`, `src/services/approval-service.ts` | `tests/integration/api.test.ts` |
| REQ-007 | Quality & security | API keys are stored hashed, the endpoints are role protected, the PII is stored in the central tables and every action is audited. | `src/security/auth.ts`, `src/repositories/user-repository.ts` | `tests/integration/api.test.ts` |
| REQ-008 | Technical & delivery constraints | Supported technology only: the Shopify Admin GraphQL API (2026-07), the Odoo external API (XML-RPC/JSON-RPC), Node.js 22 and Postgres/Neon. | `src/integrations/**` | `tests/unit/xmlrpc.test.ts`, `tests/integration/pipeline.test.ts` |
| REQ-009 | Risks & safeguards | The publish is idempotent, the ingestion is atomic, a failed publish is recorded with its request/response and the orders can be re-published with `force`. | `src/services/publish-service.ts`, `src/db/*` | `tests/integration/pipeline.test.ts` |
| REQ-010 | Priority & confirmation | The core end to end workflow is delivered first; the non essential integrations (webhooks, D365 push) are explicitly out of scope and are documented as such. | this document | — |

## 2. Evidence coverage

| Evidence | Statement | Where it is honoured |
|---|---|---|
| EV-479A4B120A | "We are downloading the shopify orders into d365 and then generate the sales orders" | The download fills the central tables; the generation creates the `sale.order` and the `sale.order.line`. |
| EV-93ED9D5E95 | "downloading takes some time … once we are picked the order taking some time to update the picking information into the sales order" | The pickings are read back automatically after the confirmation (`OdooGateway.fetchPickings`). |
| EV-9918F39277 | "Sucessfully download shopify orders into odoo" | The end to end integration test. |
| EV-734D618CA | "It should download the shopidy order 100%" | `VAL-001`, `VAL-002` and `VAL-003` compare the rebuilt order with the Shopify totals. |
| EV-90F53E666F | "Validate thr order has been downloaded 100% and generate sales order" | The validation gate in `PublishService.publish`. |
| EV-9E357474A3 | "Find the current status and next action" | `GET /api/v1/orders` exposes `status`, `validationStatus` and `approvalStatus`. |
| EV-EA0FC6E04E | "Approvals depend on a threshold" | `settings.approvalThresholdAmount` + the `approver` role. |
| EV-19ABF00D7 | "A valid request reaches the right owner" | The RBAC matrix in `src/security/auth.ts`. |
| EV-54A7BAD95E | "The service must support peak demand" | The ingestion is paged (cursor based) and bounded by `limit`; the API is stateless. |
| EV-84F7C68F2 | "Personal or customer information PII" | The PII is stored in the central tables only, never in the logs or the artefacts. |
| EV-A4B816C198 | "Only authorised roles, with an audit trail" | The hashed API keys, the permission matrix and `audit_log`. |
| EV-EF9D00184F | "We must use supported technology" | The Shopify Admin GraphQL API 2026-07 and the Odoo 19 external API. |
| EV-4A08A639D0 | "Unauthorised access or data disclosure" | Role checks, hashed keys, no secret in the database. |
| EV-144957B3C3 | "Monitoring, escalation, and an accountable owner" | The publish attempts, the audit trail and the runbook. |
| EV-EBFA498DAE | "A dependency outside our control" | The Odoo integration degrades gracefully (the addon is optional, the DMF upload falls back to a file). |

## 3. Acceptance criteria and their executable tests

| Requirement | Acceptance criterion | Test |
|---|---|---|
| REQ-001 | The recorded business context is validated against the agreed outcome and scope. | `tests/integration/pipeline.test.ts` → *downloads, validates, approves and publishes an order* |
| REQ-002 | The problem statement is validated: the download, the validation and the pickings are automated. | `tests/integration/pipeline.test.ts` → *downloads, validates, approves and publishes an order* |
| REQ-003 | The people and ownership are validated: every action is attributed. | `tests/integration/api.test.ts` → *keeps the audit trail available to the auditor only* |
| REQ-004 | The outcomes and measures are validated: the steps are timed and traceable. | `tests/integration/pipeline.test.ts` → the audit trail assertions |
| REQ-005 | The scope is validated: the order is downloaded 100 % and the sales order is generated. | `tests/unit/validation.test.ts`, `tests/integration/pipeline.test.ts` |
| REQ-006 | Given the agreed role and a valid input, the expected outcome occurs. | `tests/integration/api.test.ts` → *allows an approver to approve the order*, *publishes the order to Odoo* |
| REQ-006 | Given an unauthorised request, the system prevents it and gives an auditable result. | `tests/integration/api.test.ts` → *refuses an approval from a role that is not allowed to approve* |
| REQ-007 | The data classification, the least privilege access and the audit are validated. | `tests/integration/api.test.ts` → *refuses a request without an API key*, *refuses an unknown API key* |
| REQ-008 | The dependency inventory and the interface contracts are validated. | `tests/unit/xmlrpc.test.ts`, `tests/unit/odoo-addon.test.ts`, `tests/integration/serverless-entrypoint.test.ts` |
| REQ-009 | The misuse, the failure and the recovery are validated. | `tests/integration/pipeline.test.ts` → *blocks the publish when the validation fails*, *publishing twice is idempotent* |
| REQ-010 | The core end to end workflow is delivered first. | the whole suite |

## 4. Technical reservations

| Reservation | Status after the build |
|---|---|
| TR-01 — the architecture, the interfaces, the capacity and the support model must be validated against the estate | The interfaces are implemented against the documented Shopify 2026-07 GraphQL API and the Odoo 19 external API and are covered by tests; the capacity and the support model remain an operational decision (see the runbook). |
| TR-02 — the data quality, the migration, the reconciliation, the rollback and the recovery | The reconciliation is implemented as executable rules, the ingestion is atomic and idempotent, the publish attempts are retained for the replay.  The migration rehearsal and the recovery objectives are still to be agreed with the accountable owner. |

## 5. Open decisions carried forward

| Evidence | Question | Handling in this build |
|---|---|---|
| EV-73F0CF7EFA | The baseline, the target and the named owner for the technical constraints | The approval threshold and the Odoo identifiers are runtime settings so that the target can be set without a redeploy; the named owner still has to be recorded by the accountable decision owner. |
| EV-F430EABE23 | The baseline, the target and the named owner for the risks | The audit trail and the publish history provide the evidence; the escalation owner is to be confirmed in the runbook. |

## 6. Out of scope

The following were explicitly deferred and are **not** implemented:

* pushing the orders to D365 (the Odoo instance is the system of record for the
  sales order);
* the Shopify webhooks (the ingestion is pull based);
* the multi shop support (one shop per deployment instance);
* the returns and the exchanges workflow (the refunds are downloaded as
  financial transactions and reported, but no return order is generated).
