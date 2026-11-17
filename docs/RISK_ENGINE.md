# The risk engine (versions 2 and 3)

Version 2 added the risk engine; version 3 adds device, scam and crowd-report signals, the scam check with cooling-off, disputes, the money-flow network, a retry queue for unscored payments, and a feedback loop that retrains the model from analysts' decisions with shadow scoring and drift monitoring. The version 3 parts are marked below.

## Why it exists

The Random Forest scores one transaction from its amount and balances. Its most important training feature, `balance_discrepancy`, is always zero in this wallet because the ledger is consistent, so in live use the model rests mostly on whether the sender's wallet is emptied. It also knows nothing about how a user normally behaves or how money is moving between accounts. An attacker who sends a stolen balance in several small transfers, or passes it through other accounts, scores low on every single transaction.

The risk engine (`src/services/riskEngine.js`) adds that missing context without retraining the model.

## How a payment is assessed

Every transfer, withdrawal and bank transfer is assessed before any money moves.

1. The model scores the transaction, and the scoring service also returns how much each feature moved the score.
2. The engine reads signals from the wallet's own transaction history.
3. The model score and the signals are combined into one risk score.
4. The risk score is mapped to a response.

### Signals

| Signal | Condition | Weight |
|---|---|---|
| Velocity | The sender already made 3 or more payments out in the last 10 minutes (6 or more) | 0.20 (0.35) |
| Amount anomaly | 3 times the sender's median payment or more (10 times), with at least 5 past payments | 0.20 (0.40) |
| New recipient | No completed payment to this recipient before | 0.15 |
| Split payments | The sender already made 3 or more payments to this recipient in the last 10 minutes | 0.35 |
| Pass-through | The amount is at least 80% of the money received from other users in the last 15 minutes | 0.40 |
| Fan-in | The recipient has little history but has been paid by 3 or more other accounts in the last hour | 0.45 |
| Round trip | The recipient sent a similar amount to the sender in the last 24 hours | 0.30 |
| New device (v3) | The payment comes from a device first used on the account in the last 24 hours | 0.25 |
| New device, new payee (v3) | As above, and the recipient was never paid before that device appeared | 0.35 |
| Reported recipient (v3) | One user has reported the recipient (three or more; fraud confirmed on a payment to them) | 0.20 (0.40; 0.50) |
| Scam purpose (v3) | The sender says the payment is for something that matches a common scam (see below) | 0.30 |

Pass-through, fan-in and round trip are network signals: they look at how money moves between accounts, which is how money-mule activity shows up. The two device signals target account takeover, where a stolen password is used from the attacker's own device, usually within hours. Reports come from users (below), so the system learns about a mule account from the people who dealt with it.

### Combining

```
risk = 1 - (1 - model score) x (1 - w1) x (1 - w2) x ...
```

Each signal can only raise the risk, the result stays between 0 and 1, and with no signals the risk equals the model score.

### Response tiers

| Risk | Advisory mode (default) | Enforce mode |
|---|---|---|
| Below 0.50 | Completes | Completes |
| 0.50 to 0.80 | Completes, alert raised | Sender must enter the transaction PIN; then it completes with no alert |
| 0.80 and above | Completes, alert raised | Held: the sender is debited, the recipient is not credited, an alert is raised. The analyst releases it or refunds it |

The mode is set by `RISK_MODE` in `.env`. Advisory mode behaves as version 1 did, except that the alert decision uses the risk score rather than the model score alone.

If the scoring service is unreachable the transaction is recorded as unscored, as in version 1, and the signals alone decide the risk. Version 3 adds a retry queue (`src/services/scoringQueue.js`): every 30 seconds it scores unscored payments with the features recorded when they were made, and a payment that turns out risky raises a late alert for an analyst (test case TC-59).

## Scam protection (version 3)

Account takeover is only one kind of fraud. In authorised push-payment scams the real account owner sends the money, after being persuaded by a caller, a fake investment or a fake job offer, so a model that asks "is this the account owner?" sees nothing wrong. Version 3 adds defences aimed at the victim's decision rather than the attacker's access.

**Scam check.** In enforce mode, a first transfer of `SCAM_CHECK_MIN` (KES 1,000) or more to someone asks the sender what it is for before anything is assessed (HTTP 428 with `challenge: "purpose"`). Four of the eight answers match common scam patterns: someone called or messaged and asked me to pay; an investment or trading opportunity; a fee to get a job, prize or loan; returning money someone says they sent by mistake. Choosing one shows a warning written for that scam and adds the scam-purpose signal.

**Cooling-off.** A payment with a risky purpose is not sent at once. The money leaves the sender's wallet into a held account, the sender sees a countdown, and the payment is released after `COOLING_OFF_MINUTES` (30) unless the sender cancels it, which returns the money in full. The pause gives a victim time to call someone, which is when most scams fall apart. A background task releases due payments every 15 seconds. Test cases TC-47 and TC-48 cover both outcomes.

**Confirmation of payee and warnings.** The recipient's registered name is shown before every transfer (version 2). In version 3 the check also warns when other users have reported the account.

**"This wasn't me" and recipient reports.** From the receipt of any payment, the sender can dispute it. A dispute freezes the account straight away, in case it has been taken over, and goes to an analyst. Upholding it recovers what the recipient still holds and freezes the recipient's account; the user's account is restored once they are back in control. A user can also report an account they have dealt with; reports feed the reported-recipient signal and the payee warning. Only someone who has exchanged money with an account can report it, and only once, so reports cannot be used to attack an innocent account. Test cases TC-49 and TC-51 cover these.

**Self-freeze.** A user who loses their phone can freeze their own account from **Security**; only an administrator can lift it.

## The money-flow network (version 3)

The console's **Network** page draws the transfers around any account, two or three hops out (`src/services/graph.js`), with flagged and held payments marked, and lists the accounts whose recent flows look most like mule activity: money passed straight on, many senders paying one new account, money going round in a cycle. The network signals above look one step around a single payment; this view lets an analyst follow the chain.

## Learning from decisions (version 3)

The model was trained once on PaySim. Version 3 closes the loop between the analysts and the model (`src/services/modelOps.js` and the scoring service's `/models` endpoints).

1. **Labels.** Every decision becomes a labelled example: a confirmed alert or an upheld dispute is fraud; a cleared alert or a rejected dispute is legitimate; fraud API clients send their own labels.
2. **Retraining.** From the console's **Models** page an administrator retrains. The scoring service trains a challenger on PaySim plus the live examples, weighted twenty times each because they are few and closest to real use, with the same parameters and seed as the original. When each class has at least five live examples, 30% of them are held back to compare the challenger and the champion on live data as well as on the PaySim test set.
3. **Shadow scoring.** While a challenger exists, every payment is also scored by it, but only the champion's score counts. The Models page compares the two on recent payments and on labelled ones.
4. **Promotion and rollback.** The administrator promotes the challenger when it does better; the previous champion is archived and can be restored with one click. Every change is written to the audit log, and every assessment records the model version that made it.
5. **Drift.** The page measures, for each model feature, how far recent live payments have moved from the training data, using the population stability index (PSI): the training distribution is stored as ten quantile bins (with a separate bin for exact zeros, which are common in balances), and PSI = Σ (live share − training share) × ln(live share / training share). By the usual rule of thumb, below 0.1 is stable, 0.1 to 0.25 a moderate shift and above 0.25 a major one.

In this wallet every feature shows major drift, and that is a finding rather than a fault: PaySim's amounts and balances are on a different scale from a test wallet's KES amounts, and PaySim's `balance_discrepancy` is often non-zero where the wallet's ledger keeps it at zero. It is the evidence for why the behavioural signals and the feedback loop are needed alongside the original model. Test cases TC-57 and TC-58 cover retraining, shadow scoring and drift.

The scoring service keeps its models in `MODEL_DIR` (in Docker, a volume), so promoted models survive a restart. Its administration endpoints accept a request only with the shared `ML_ADMIN_TOKEN`, or from the same machine when no token is set.

## Explanations

For each score, the scoring service follows the transaction's path through every tree in the forest. At each split the fraud probability changes, and the change is credited to the feature the split used. Averaged over the 200 trees this gives one contribution per feature, and the contributions add up exactly:

```
model score = base value + sum of contributions
```

This is the decision-path method of attributing a tree ensemble's prediction (Saabas's method, also implemented by the `treeinterpreter` package). It was chosen over the SHAP library because it is exact for this identity, needs no extra dependency and is cheap: it measured about 3 milliseconds per request in testing. SHAP's TreeExplainer distributes credit between interacting features more evenly and would be the natural next step.

The model score, base value, contributions, signals, tier and action are stored in the transaction's `metadata.risk` and shown to the analyst on the alert. The person making the payment is told only the tier and the reasons that concern their own activity; a signal about the recipient's account is worded generally and the challenge carries no scores. (As in version 1, senders can see the fraud score of their own completed payments in their activity list.)

## Order of work and concurrency

Payments are processed one at a time for each sender. Without this, payments sent in parallel would each be assessed against a history that did not yet include the others, and a burst could slip past the velocity and split-payment signals. PIN attempts are counted in the same queue. Test case TC-39 sends eight transfers at once and checks that no more than three go through before the PIN is asked for.

## Limits to state honestly

- The signal weights and thresholds were set by hand and adjusted using the attack lab's scenarios. They have not been validated on labelled real-world behaviour, because PaySim has no usable per-account history; the lab's detection figures are therefore results on the scenarios the engine was tuned against, not an estimate of real-world detection.
- The lab's "normal behaviour" scenario is small. The false-alarm rate on real users is unknown, and the step-up tier (a PIN prompt rather than a block) was chosen so that a false alarm costs the user a few seconds rather than a failed payment.
- The network signals look one step around a transaction. They are not a full graph analysis and would miss longer or slower chains.
- A 4-digit PIN protects against someone who has the session or the password but not the PIN: setting a first PIN needs the password, and changing it needs the current PIN as well. It is not a second device factor, there is no way to reset a forgotten PIN, and the lock allows five attempts every 15 minutes without growing longer.
- The one-at-a-time queue and the sign-in rate limit live in the web process, so they assume the single-process deployment described in `docs/DEPLOYMENT.md`.
- The version 3 weights (device, reports, purpose) were also set by hand. The scam check relies on the sender answering honestly; a victim being coached by a scammer may pick an ordinary purpose, which is why the cooling-off and dispute paths exist as well.
- Retraining on a handful of live labels changes the model little and can over-fit them; the hold-out comparison is reported so an administrator can see this, and promotion is always a human decision.
