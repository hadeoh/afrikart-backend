# Afrikart Backend

NestJS + Mongoose integration with the Fincra-style sandbox API.

**Role**: Senior Product Engineer  

---

## Quick start (one command)

```bash
./start.sh
```

The script installs dependencies, starts MongoDB (if Docker is available), and boots the NestJS server on port 3000.

**Prerequisites**: Node.js ≥ 18, npm, MongoDB (local or via Docker).

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values for the hosted sandbox.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | NestJS server port |
| `MONGO_URI` | `mongodb://localhost:27017/afrikart` | MongoDB connection string |
| `AFRIKART_BASE_URL` | `http://localhost:4000` | Sandbox API base URL (change for hosted judging) |
| `AFRIKART_SECRET_KEY` | — | `api-key` header value |
| `AFRIKART_PUBLIC_KEY` | — | `x-pub-key` header value |
| `AFRIKART_WEBHOOK_SECRET` | — | HMAC secret for webhook verification |
| `PAYOUT_UNCERTAINTY_THRESHOLD_MS` | `60000` | How long a PROCESSING payout waits before flagged UNCERTAIN |

Point the sandbox at this app's webhook endpoint:

```
WEBHOOK_TARGET_URL=http://localhost:3000/webhooks/fincra
```

Set this in the **sandbox** `.env`, not this app's `.env`.

---

## Run / test commands

```bash
npm install
npm run start:dev          # dev mode with hot-reload
npm run build && npm start # production
npm test                   # unit tests (no DB required)
```

---

## Architecture overview

```
┌────────────────────────────────────────────────────────┐
│                    NestJS Backend                       │
│                                                         │
│  POST /collections/checkout  ──► CollectionsService    │
│  POST /payouts               ──► PayoutsService        │
│  POST /webhooks/fincra       ──► WebhooksService       │
│  GET  /timeline/transactions/:ref                       │
│  GET  /timeline/payouts/:ref                           │
│  GET  /timeline/provider-events                        │
│  GET  /timeline/wallet-logs                            │
│                                                         │
│  FincraService (HTTP client, retries, error mapping)   │
└──────────────┬─────────────────────────────────────────┘
               │
         Fincra Sandbox API (http://localhost:4000)
```

Modules:

| Module | Responsibility |
|---|---|
| `FincraModule` | HTTP client wrapper for all sandbox endpoints; handles chaos-mode retries |
| `CollectionsModule` | Checkout initiation, Transaction schema, collection webhook handler |
| `WebhooksModule` | HMAC-SHA512 signature verification, idempotency guard, event routing |
| `PayoutsModule` | Account verification, payout state machine, Fincra submission |
| `TimelineModule` | Operator-facing chronological lifecycle views |

---

## Data model

### `transactions` collection

```
internalRef         string  unique   Our checkout reference (submitted to Fincra)
fincraPaymentId     string           Fincra txn_... ID; links to wallet credit logs
amount / currency / customer / metadata
status              pending | successful | failed
channel             string           bank_transfer | card (set by webhook)
feeAmount / vatAmount
timeline            TransactionEvent[]  append-only event log
```

### `payouts` collection

```
customerReference   string  unique   Caller-supplied stable key; idempotency lock
idempotencyKey      string           Sent to Fincra as x-idempotency-key (= customerReference)
sourceTransactionRef string          Links payout → collection (joins the lifecycle)
fincraPayoutReference string         Fincra's payout.reference
fincraPayoutId      string           Fincra's payout.id (po_...); links to wallet debit logs
amount / sourceCurrency / destinationCurrency / fee / rate
recipient           object           name, accountNumber, bankCode, verifiedName
status              PayoutStatus     (state machine below)
failureReason       string
timeline            PayoutEvent[]    append-only state-transition log
attemptCount        number
```

### `processed_webhooks` collection

```
fincraEventId       string  unique   Fincra evt_... ID; duplicate-key = already processed
eventType           string
processedAt         Date             TTL index: auto-expire after 30 days
```

---

## Reference model (how the IDs connect)

```
Our store                    Fincra's store              Fincra balance logs

Transaction
  .internalRef  ←────────── payment.reference / collection webhook .reference
  .fincraPaymentId ←──────── payment.id (txn_...)  ←──── balanceLog.reference (credits)

Payout
  .customerReference ───────► payout.customerReference (echo'd back)
  .idempotencyKey ────────── x-idempotency-key header → Fincra deduplication
  .fincraPayoutReference ←── payout.reference (payout_...)
  .fincraPayoutId ←────────── payout.id (po_...)  ←───── balanceLog.reference (debits)

  .sourceTransactionRef = Transaction.internalRef  (our join key)

ProcessedWebhook
  .fincraEventId ←─────────── event.id (evt_...)
```

**Single tracing key for ops**: `Transaction.internalRef` follows the money from collection through every linked payout.

---

## Idempotency model

| Risk | Guard | Mechanism |
|---|---|---|
| UI double-submit on checkout | `Transaction.internalRef` unique index | Second request returns 409 before calling Fincra |
| Duplicate webhook delivery | `ProcessedWebhook.fincraEventId` unique index | Duplicate-key error = skip; atomic at DB level |
| Payout double-submit | `Payout.customerReference` unique index | Second request returns the existing payout; `x-idempotency-key` also sent to Fincra |

No in-memory state is used for idempotency — all guards survive process restarts.

---

## Payout state machine

```
                      ┌─── verification_failed (terminal, safe — no funds moved)
                      │
INIT ──────────► verification_pending
                      │
                  (verify OK)
                      │
                  processing ──── webhook(payout.successful) ──► successful (terminal)
                      │
                      ├────────── webhook(payout.failed) ───────► failed (terminal)
                      │           (Fincra restores wallet balance)
                      │
                      └────────── no webhook after threshold ───► uncertain
                                  (ops review; can transition to successful|failed)
```

Transitions are enforced in `PayoutsService.transition()`. No code path can move state backward or skip a step.

---

## Retry rules

| Condition | Action |
|---|---|
| 503 with `errorType = PROVIDER_ERROR` (chaos mode) | Retry up to 3×; exponential backoff with jitter: ~1s, ~2s, ~4s |
| 400 / 401 / 404 / 409 | No retry — deterministic errors |
| 429 | No retry — honor `retryAfter` from response |
| Payout submission failure | Payout stays in PROCESSING; idempotency key means a later retry or webhook resolves it |

---

## Human-facing uncertainty

When a payout is PROCESSING longer than `PAYOUT_UNCERTAINTY_THRESHOLD_MS` (default 60s) without a webhook:

1. Status transitions to `uncertain`
2. The payout `timeline` records the transition with the threshold value
3. `GET /timeline/payouts/:customerReference` surfaces this to ops
4. Ops can re-query Fincra's `GET /disbursements/payouts/reference/:ref` to check the provider side
5. Once resolved, ops can manually verify state via API and the payout can be marked terminal

The user never sees "unknown" — they see "processing" until the system resolves it.

---

## Known limitations

| Item | Detail |
|---|---|
| Uncertainty timer | Uses `setTimeout` — not durable across process restarts. Production should use a job queue (BullMQ) with a delayed job. |
| Payout retry from UNCERTAIN | Manual only — the API does not yet expose a "retry payout" endpoint. |
| No auth on our API | No API key guard on our own endpoints; production must add auth. |
| Concurrent scale | Mongoose's `findOneAndUpdate` is atomic per document but not distributed; horizontal scaling needs a distributed lock for payout creation. |
| Mobile-money payout | Ready: add `PayoutRail` enum to Payout schema, swap `FincraService.createPayout()` call in `submitToFincra()`. State machine, idempotency, and timeline unchanged. |

---

## ADR-001: Raw body capture for webhook HMAC verification

**Decision**: Use NestJS's `rawBody: true` option to capture the raw request bytes alongside the parsed JSON body.

**Context**: The sandbox signs `JSON.stringify({event, data})` with HMAC-SHA512 and sends those exact bytes as the HTTP body. Signature verification must run over the same byte string.

**Rejected alternative**: Re-serialize the parsed body with `JSON.stringify(req.body)` before verifying. This fails if:
- Key insertion order differs between the sender's JSON serializer and Node's
- The sender includes/excludes whitespace differently
- Any middleware mutates the parsed object before the controller receives it

**Trade-off**: `rawBody: true` doubles the memory footprint of every request body (raw buffer + parsed object). Acceptable for webhook payloads which are small (<4 KB).

---

## ADR-002: Embedded timeline arrays vs. separate events collection

**Decision**: Store the transaction and payout timelines as embedded arrays (`timeline: TransactionEvent[]`) inside their parent documents.

**Context**: Ops need to reconstruct the full lifecycle of a transaction without reading app logs. The question is whether events should be stored in a separate `events` collection or embedded.

**Rejected alternative**: A separate `events` collection with foreign keys. Problems:
- Requires a multi-document read (transactions + events) to build the lifecycle view
- Append operations are not atomic with the parent state update — a crash between the state update and the event insert leaves the audit log inconsistent
- Cross-collection queries are harder to paginate and sort correctly

**Trade-off**: Embedded arrays grow unboundedly if a transaction generates thousands of events. For this use case (payment lifecycle = tens of events at most), that's not a concern. At scale, cap the embedded array at N entries and overflow into a secondary collection.

---

## Demo script

### Happy path

```bash
# 1. Start sandbox (in participant-repo) with webhook target pointed at our app
WEBHOOK_TARGET_URL=http://localhost:3000/webhooks/fincra bun run start

# 2. Start our app (in afrikart-backend)
./start.sh

# 3. Initiate a checkout
curl -s -X POST http://localhost:3000/collections/checkout \
  -H 'content-type: application/json' \
  -d '{
    "amount": 25000,
    "currency": "NGN",
    "customer": { "name": "Maya Okafor", "email": "maya@example.com" },
    "metadata": { "orderId": "1001" }
  }' | jq .
# → returns internalRef, e.g. "ord_1749012345_a1b2c3d4"

# 4. Settle the collection (triggers collection.successful webhook to our app)
curl -s -X POST http://localhost:4000/simulate/collections/settle \
  -H 'content-type: application/json' \
  -d '{ "reference": "ord_1749012345_a1b2c3d4", "status": "successful" }' | jq .

# 5. Check our transaction is now successful
curl -s http://localhost:3000/collections/ord_1749012345_a1b2c3d4 | jq .status

# 6. Initiate a payout (customerReference is caller-supplied)
curl -s -X POST http://localhost:3000/payouts \
  -H 'content-type: application/json' \
  -d '{
    "customerReference": "vendor_settlement_order_1001",
    "amount": 10000,
    "sourceCurrency": "NGN",
    "sourceTransactionRef": "ord_1749012345_a1b2c3d4",
    "recipient": {
      "name": "Ada Lovelace",
      "accountNumber": "0123456789",
      "bankCode": "058",
      "email": "ada@example.com"
    }
  }' | jq .

# 7. View the full timeline (ops view — no log reading needed)
curl -s http://localhost:3000/timeline/transactions/ord_1749012345_a1b2c3d4 | jq .
```

### Failure path (account ending in 9 → payout fails, funds restored)

```bash
curl -s -X POST http://localhost:3000/payouts \
  -H 'content-type: application/json' \
  -d '{
    "customerReference": "vendor_settlement_fail_test",
    "amount": 5000,
    "recipient": {
      "name": "Fatima Invalid",
      "accountNumber": "0000000009",
      "bankCode": "058"
    }
  }' | jq .

# Wait ~2s for the payout.failed webhook, then:
curl -s http://localhost:3000/payouts/vendor_settlement_fail_test | jq '{status: .data.status, reason: .data.failureReason}'
# → { "status": "failed", "reason": "..." }

# Timeline shows: processing → failed, actor: webhook
curl -s http://localhost:3000/timeline/payouts/vendor_settlement_fail_test | jq .data.timeline
```

### Architectural highlight — duplicate webhook replay

```bash
# Trigger a duplicate delivery using the sandbox replay endpoint
curl -s http://localhost:4000/events -H 'api-key: sk_test_afrikart_secret' | jq '.data[0].id'
# → "evt_1749012345_ab12"

curl -s -X POST http://localhost:4000/simulate/webhooks/replay/evt_1749012345_ab12 \
  -H 'api-key: sk_test_afrikart_secret'

# Our app returns: { "processed": false, "reason": "duplicate" }
# Transaction status unchanged. No double credit.
```
