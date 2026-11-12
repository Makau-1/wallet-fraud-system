# The risk engine (version 2)

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

The last three are network signals: they look at how money moves between accounts, which is how money-mule activity shows up.

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

If the scoring service is unreachable the transaction is recorded as unscored, as in version 1, and the signals alone decide the risk.

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
