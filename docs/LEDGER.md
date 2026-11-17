# The ledger, audit log and reconciliation (version 3)

Versions 1 and 2 kept money as a balance column on each wallet, changed in place. That is enough to run a wallet, but it cannot answer the questions an auditor or a regulator asks first: where did this shilling come from, has any record been altered, and do the books still add up? Version 3 adds the controls a payment system is expected to have, without changing how users see their money.

## Double-entry journal

Every movement of money is posted to an append-only journal (`src/services/journal.js`) as an entry with two or more lines. Each line debits or credits one account, and the lines of an entry always add up to zero, so money is never created or destroyed by a posting; it only moves between accounts.

| Account | What it holds |
|---|---|
| `wallet:<id>` | A user's spendable balance |
| `savings:<id>` | A locked savings goal |
| `loan:<id>` | A loan: the principal lent, less what has been repaid |
| `held:<transaction id>` | A payment held for review or in its cooling-off period: the sender has been debited, the recipient not yet credited |
| `chama:<id>` | A group's shared pot |
| `external:cash`, `external:bank`, `external:merchants`, `external:mpesa` | Money entering or leaving the system: deposits, withdrawals, bank transfers, bill payments, M-Pesa |
| `external:lab`, `external:closed` | Attack-lab funding, and balances of test accounts that were deleted |
| `equity:opening` | Balances that existed before the journal was switched on |

A transfer of KES 500 from wallet 7 to wallet 9 is one entry with two lines: `wallet:7 −500` and `wallet:9 +500`. A held transfer is posted as `wallet:7 −500`, `held:1234 +500`, and its release as `held:1234 −500`, `wallet:9 +500`; a refund moves it back to `wallet:7` instead. The journal entry is written in the same database transaction as the balance change, so one cannot happen without the other.

When the journal is first switched on (`node scripts/migrate.js`, or the first start of the server), the existing balances are posted once against `equity:opening`, so an existing database joins the journal without losing its history.

## Append-only, hash-chained records

The journal tables and the audit log are protected in two ways.

**The database refuses changes.** Triggers on `journal_entries`, `journal_lines` and `audit_log` reject every `UPDATE` and `DELETE` (`SIGNAL SQLSTATE '45000'`). Corrections are made the way accountants make them, by posting a new entry that reverses the old one.

**Each record is chained to the one before it.** Every journal entry and every audit record stores `hash = SHA-256(previous hash + "\n" + payload)`, where the payload is a canonical JSON form of the record's contents. The latest hash of each chain is kept in `chain_heads`, and the row is locked (`SELECT … FOR UPDATE`) while a record is added, so two records can never claim the same predecessor. Someone with direct database access could drop the triggers and edit a row, but the edit would break the chain from that point on, and verification would report exactly which record no longer matches.

The audit log (`src/services/audit.js`) records every administrator decision (alerts, held payments, disputes, freezes, API clients, model promotion and rollback) and security events such as sign-ins from new devices and PIN or two-step changes, each with who did it, when, from which address, and what changed.

## Reconciliation

`src/services/reconcile.js` checks that the books agree with themselves. It runs every night at `RECONCILE_HOUR` (2 a.m. by default), on demand from the console's **Ledger** page, and from the command line with `node scripts/reconcile.js`, which exits with an error when anything is wrong so it can fail an automated build. It checks that:

1. every journal entry balances, and the whole journal sums to zero;
2. both hash chains verify from the first record to the head, and each entry's stored payload matches its lines;
3. every wallet, savings goal, loan, chama pot and held payment equals the balance of its journal account;
4. every completed transaction has a journal entry.

Each run is stored in `reconciliation_runs` with what was checked and every difference found. In testing, a journal line edited by hand (with the triggers removed) was reported four ways: the entry no longer balanced, the journal no longer summed to zero, the chain broke at that entry, and the wallet no longer matched its account.

After the 50-user load test (`tests/results/load-test-50-users.md`), with about 1,400 transfers made concurrently, reconciliation verified 6,282 journal entries and found no differences.

## Idempotency keys

A phone on a weak network may send a payment, lose the reply and send it again. Every money-moving request from the website carries an `Idempotency-Key` header (a random value made when the user presses Confirm). The first response for a key is stored for 24 hours; a repeat with the same key gets the stored response back and moves no money, and the same key with a different request is refused with HTTP 422. Only successful responses are stored, so a payment that failed can be retried. Test case TC-43 checks this.

## Two-person approval

Releasing or refunding a held payment of `TWO_PERSON_THRESHOLD` (KES 10,000) or more, and upholding a dispute of that size, needs two different administrators. The first records a proposal (HTTP 202); the money moves only when a different administrator approves it, and that administrator can reject it instead. The rule stops one compromised or dishonest administrator account from moving large sums alone. Test case TC-50 checks it.

## Limits

- The journal is in the same database as the balances, so a database administrator could in principle rewrite both the data and the whole chain. Anchoring the chain head outside the database (for example, publishing it daily) would close this gap.
- Amounts are stored as `decimal(18,2)` and summed in integer cents in JavaScript; there is one currency (KES).
