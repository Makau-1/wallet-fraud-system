# Evidence: testing, attack scenarios, load and model validation (version 3)

The project report's evaluation rests on 26 functional test cases and the model's scores on a held-out PaySim test set. Version 3 adds four further kinds of evidence. Each is reproducible with one command, and each section ends with what it does not show.

## 1. Test cases

| Suite | Cases | Command | Mode |
|---|---|---|---|
| Version 1 | TC-01 to TC-26 (TC-16 separately, with scoring stopped) | `node tests/run-tests.js` | advisory |
| Version 2 | TC-27 to TC-40 | `node tests/run-v2-tests.js` | enforce, attack lab on |
| Version 3 | TC-41 to TC-65 | `node tests/run-v3-tests.js` | enforce, attack lab and USSD simulator on |

Version 3 cases cover the double-entry journal, the hash-chained audit log, idempotency keys, live notifications, new-device sign-in, two-step sign-in, the scam check and cooling-off, disputes, two-person approval, recipient reports, paying a phone number, M-Pesa, USSD, chamas, the fraud API and webhooks, retraining and shadow scoring, drift, the retry queue, the network view, the attack lab, data export, the usability questionnaire, latency metrics, and a final reconciliation. In advisory mode the cases that need enforcement are reported as "Not run". Results are written to `tests/results/` as Markdown and JSON, with expected and actual results for each case, and GitHub Actions runs every suite on each push, reconciling the books after each one.

Results on version 3, 17 November 2026:

| Suite | Result | File |
|---|---|---|
| Version 1, advisory mode | 25 of 25 passed | `results-v1-on-v3.md` |
| TC-16, scoring service stopped | 1 of 1 passed | `results-tc16-on-v3.md` |
| Version 2, enforce mode | 14 of 14 passed | `results-v2.md` |
| Version 3, enforce mode | 25 of 25 passed | `results-v3.md` |
| Version 3, advisory mode | 21 of 21 passed, 4 not run (they need enforce mode) | `results-v3-advisory.md` |

Reconciliation after the runs verified 6,740 journal entries and 1,216 audit records with no differences, and again after the test accounts were deleted. `results.md` and `results-tc16.md` are kept unchanged as the version 1.0 run reported in Chapter 5 of the project report.

## 2. The attack lab

With `ATTACK_LAB=1`, the console's **Attack lab** runs scripted fraud through the real payment path with throwaway accounts: account takeover, rapid draining, a money-mule chain, a collector account, round trips, a phone-scam victim, a reported mule account, takeover from a new device, and a normal-behaviour scenario that should raise nothing. **Run all** compares the full engine with the model on its own.

On the last run in enforce mode the full engine caught 16 of the 16 attack steps expected to be caught, the model on its own caught 3 of 16, and none of the 7 ordinary steps raised a false alarm (test case TC-61).

These figures are on the scenarios the engine's weights were tuned against, so they show that each defence works as designed, not how much real fraud it would catch.

## 3. Load test

`node scripts/load-test.js <users> <seconds>` signs up that many simulated users, then has each one, with no pause, check the balance, view the history and send a transfer, over and over. Every transfer runs the full path: the risk assessment with a call to the model, the PIN check when challenged, the journal entry and the audit record.

Measured on 17 November 2026 on a 2-core cloud machine with 8 GB of memory, running the website, the scoring service, the database and the load generator together (`tests/results/load-test-*.md`):

| Users | Requests a second | Transfer median | Transfer 95th percentile | Balance median | Errors |
|---|---|---|---|---|---|
| 10 | 61.7 | 357 ms | 571 ms | 65 ms | none |
| 50 | 73.4 | 1,271 ms | 2,350 ms | 484 ms | none |

All 6,255 requests succeeded, and a reconciliation afterwards verified 6,282 journal entries with no differences, so the books stayed correct under concurrent load.

Throughput levels off at about 24 transfers a second on this machine; beyond that, more users only make each one wait longer. The load test found one bottleneck, which was fixed: the scoring service spread each single prediction across worker processes, which took about 39 ms a call; scoring one payment in a single process takes about 13 ms. The remaining cost is mostly the PIN check (bcrypt is slow on purpose) and the shared CPU.

The simulated users send far faster than any person, so most of their transfers trip the velocity check and need the PIN; the figures are a pessimistic ceiling for the transfer path. They come from one small machine running everything, not from production hardware. The test should be repeated on the deployed server, from a separate machine, with `node scripts/load-test.js 50 60 https://your-domain`.

## 4. Model validation beyond the 80/20 split

The model was trained and tested on a sample of PaySim: all 8,213 fraud cases among TRANSFER and CASH_OUT payments and 41,065 legitimate ones. About 2.7 million legitimate payments of those types were never used. `ml/validate_external.py` uses them for three further checks:

1. **Every legitimate payment the model never saw.** The current model scores all of them. This measures the false-alarm rate on millions of payments rather than thousands and, combined with the recall on the held-out fraud cases, gives the precision to expect at PaySim's real fraud rate (about 0.3%) rather than the 1% test set used in the report.
2. **Trained on the past, tested on the future.** A new model with the same settings is trained only on payments from the first 80% of the simulated month and tested on every later payment, at the real fraud rate. A random split lets the model learn from payments that happen after the ones it is tested on; a time split does not.
3. **Another dataset (optional).** Any log in PaySim's column format, such as a new run of the PaySim simulator with a different seed, can be scored by the current model unchanged with `--other`.

The raw PaySim log (about 470 MB) is not in the repository. To run the checks, download it from Kaggle (https://www.kaggle.com/datasets/ealaxi/paysim1), save it as `ml/data/paysim.csv`, and from the `ml` folder run:

```
venv\Scripts\python.exe validate_external.py
```

It takes a few minutes and writes `ml/results/validation.md` and `validation.json`. The script was tested here on a synthetic file in PaySim's format; the real figures have to come from the user's own run, because the raw dataset could not be downloaded in the environment where version 3 was built.

All three checks remain on simulated data. A model trained on PaySim has not been tested on real mobile money traffic, and no public dataset of real mobile money fraud with the same fields exists to test it on; the drift check (`RISK_ENGINE.md`) shows how far the wallet's live payments already differ from the training data.

## 5. Usability

The System Usability Scale questionnaire is built into the wallet (`/survey.html`), and the results are summarised on the console. The study protocol is in `docs/USABILITY_STUDY.md`. No study has been run yet; the questionnaire and its scoring are tested (TC-63), not the results.

## 6. Code review

Before release, version 3 was reviewed by a reviewer who had not written it, looking for ways to create or lose money, bypass a control, or read someone else's data. Every confirmed finding was fixed and the suites re-run:

| Finding | Fix |
|---|---|
| Wrong two-step codes sent in parallel could all be checked before the attempt count rose | Attempts are counted before any database call; at most five per sign-in and ten per account in 15 minutes; a code can be used once even by parallel requests |
| The M-Pesa callback address had a fixed default secret | No default: a random secret per start, and the sandbox refuses to run without a 32-character one |
| On an empty database, `migrate.js` stopped at the first migration | An empty database is built from `schema.sql`, then every migration is recorded |
| The USSD simulator accepted any phone number without signing in | Signed-in users only, dialling from their own linked number (TC-54) |
| Freezing an account returned large held payments without a second administrator | Held payments above the two-person threshold stay held for the alert's decision |
| Wrong current PINs on the change-PIN form did not count towards the PIN lock | They count; five lock the PIN |
| The journal's opening time was in UTC while transactions use server time | Both in server time |
| Senders could see the combined risk score in enforce mode | Withheld in enforce mode, shown in advisory mode as in version 1 |
| Deleting test or lab accounts could take a real sender's held payment with them | Such payments are refunded to the sender first |
| Webhook address checks could be dodged by DNS rebinding and some address forms | The address is checked on the connection itself, against a fuller list of private ranges |
| Accounts invited to a chama after a payout was proposed could vote on it | Only members who had joined by then may vote |
| A stolen session could turn on two-step sign-in and lock the owner out | Turning it on needs the account password |
| An interrupted request could leave an idempotency key blocked for 24 hours | Unfinished keys are released when the connection closes, or after two minutes |
