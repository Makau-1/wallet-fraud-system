# The fraud API (version 3)

The risk engine that protects SecureWallet's own payments is also offered to other businesses, such as a small wallet, a payment gateway or a SACCO, that cannot build fraud detection of their own. A client sends each outgoing payment to the API before completing it and gets back a decision, the reasons for it and the model's explanation. The live documentation, with a form for trying a key, is at `/developers.html`, and the OpenAPI description at `/api/v1/openapi.json`.

## Getting a key

An administrator creates the client on the console's **Fraud API clients** page. The API key (`swk_live_…`) and the webhook secret (`whsec_…`) are shown once; the database keeps only a SHA-256 hash of the key. Keys can be revoked and new ones issued without changing the client, the webhook secret can be rotated, and a client can be suspended. Each client has a rate limit (120 requests a minute by default, adjustable from 1 to 6,000), applied as a token bucket; requests over it get HTTP 429.

## Endpoints

All requests send `Authorization: Bearer <key>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/assess` | Assess a payment before completing it |
| GET | `/api/v1/assessments/:id` | Fetch an earlier assessment |
| POST | `/api/v1/assessments/:id/outcome` | Report whether the payment was completed or declined |
| POST | `/api/v1/assessments/:id/feedback` | Label it fraud or legitimate once known |
| GET | `/api/v1/usage` | The client's request counts and decisions |

A request to assess:

```json
{
  "external_id": "pay_1001",
  "type": "TRANSFER",
  "amount": 2500,
  "account_id": "cust_118",
  "counterparty_id": "cust_904",
  "account_balance": 2600,
  "counterparty_balance": 120
}
```

The answer:

```json
{
  "id": "asm_1042",
  "decision": "allow",
  "risk": 0.31,
  "model_score": 0.17,
  "reasons": ["First payment to this recipient"],
  "explanation": { "base_value": 0.5, "contributions": [] },
  "model_version": "rf-20261117-061941-0live",
  "status": "completed"
}
```

| Decision | Risk | What the client should do |
|---|---|---|
| `allow` | below 0.50 | Complete the payment |
| `challenge` | 0.50 to 0.80 | Ask the customer for a second factor (a PIN or a one-time code) first |
| `review` | 0.80 and above | Hold the payment for a person to check |

`external_id` is the client's own payment reference. Sending the same one again returns the first assessment instead of assessing twice, so a client can safely retry after a timeout.

## How the history is kept separate

The behavioural and network signals (velocity, unusual amounts, new recipients, split payments, pass-through, fan-in, round trips) need each customer's history. For an API client they are read from the payments that client has sent (`api_events`), through the same engine the wallet uses with a different history provider (`apiHistory` in `src/services/fraudApi.js`). Each client's customers are judged only against that client's own traffic, and no client can see another's data. A payment reported as declined stops counting in the history.

## Webhooks

When an assessment comes back as `challenge` or `review` and the client has a webhook URL, the URL receives an `assessment.flagged` event:

```
POST <webhook url>
SecureWallet-Event: assessment.flagged
SecureWallet-Signature: t=1763362800,v1=5f2c…

{"id":"evt_…","type":"assessment.flagged","created":"…","data":{ …the assessment… }}
```

`v1` is the hex HMAC-SHA256, keyed with the webhook secret, of `"<t>.<raw body>"`. The receiver recomputes it, compares it in constant time, and rejects a mismatch or a timestamp more than five minutes old. `scripts/webhook-receiver.js` is a working receiver. A delivery that fails is retried after 1, 5, 15, 60 and 360 minutes, and every attempt is listed on the client's page. In production a webhook URL must use HTTPS and may not resolve to a private or local address, so the server cannot be made to call internal systems.

## Feedback into the model

Labels sent to `/feedback` join the analysts' alert and dispute decisions as labelled examples for retraining (see `RISK_ENGINE.md`, "Learning from decisions").

## Trying it

```
node scripts/api-demo.js                    # with SECUREWALLET_KEY set to a key
WEBHOOK_SECRET=whsec_… node scripts/webhook-receiver.js 4000
```

The demo sends five ordinary payments for one customer and then a takeover that empties the account to a stranger. In testing the first five were allowed and the takeover came back as `review` with risk 0.94 and the reasons "5 payments out in the last 10 minutes", "Amount is 17 times the sender's usual payment" and "First payment to this recipient", and the receiver verified the signed webhook. Test case TC-56 checks keys, decisions, idempotent retries, the rate limit and the webhook signature.

On Windows PowerShell, set the variables first: `$env:SECUREWALLET_KEY = "swk_live_…"`.

## Limits

The API is a demonstration of the engine as a service, not a commercial product: there is no billing, no self-service sign-up and no service-level guarantee, and the rate limiter lives in the web process.
