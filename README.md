# SecureWallet

A simulated web-based digital wallet with real-time, Random Forest-based fraud detection, built as a final-year Computer Science project at Strathmore University (Alex Makau, 165926; supervisor Dr Esther Khakata).

**Problem.** Large payment platforms score transactions with machine learning, but those capabilities are proprietary, while smaller and educational wallets rely on fixed rules or have no fraud detection. SecureWallet shows, in a form that can be inspected and reproduced, how a machine learning model can be built into a wallet's transaction pipeline, from the moment a transaction is made to the decision of a human reviewer.

**What it does.** Users deposit, withdraw and send money, send money to a bank, pay bills and shops, buy airtime, save in locked savings goals, borrow and repay loans, and request money from each other. Every transfer, withdrawal and bank transfer is scored by the model as it is made. Transactions scoring 0.50 or above are raised as alerts for an administrator to confirm as fraud or dismiss. In version 1.0, and in the default advisory mode of version 2, flagged transactions are not blocked.

No real money moves. The model is trained on PaySim, a synthetic mobile money dataset.

## Version 3 (this branch)

Version 1.0, the version described in the project report, is tagged `v1.0`. Version 2 added a risk engine on top of the model; version 3 turns the prototype into a platform with the controls a real payment system needs. A full description of what each version adds, and why, is in the `docs` folder.

**Fraud detection**

- **A risk engine** (version 2, extended in 3). The model score is combined with behavioural signals (velocity, unusual amounts, first-time recipients, split payments), network signals (pass-through, fan-in, round trips), device signals (a payment from a device first used in the last day) and reports from other users. With `RISK_MODE=enforce`, unusual payments need the transaction PIN and high-risk ones are held for an analyst. Every alert explains which features and signals raised it. See `docs/RISK_ENGINE.md`.
- **Scam protection** (3). A first large payment to someone asks what it is for; answers that match common scams show a warning and start a cooling-off period during which the sender can cancel. Users can dispute a payment ("This wasn't me"), which freezes the account and lets an analyst claw the money back, and can report accounts that scammed them.
- **A money-flow network view** (3) that follows transfers two or three hops around an account and lists likely mule accounts.
- **A feedback loop** (3). Analysts' decisions become labelled examples; an administrator retrains a challenger model, compares it with the champion in shadow on live payments, promotes it or rolls back. Drift between live payments and the training data is measured with the population stability index.
- **An attack lab** (2, extended in 3) that runs nine scripted scenarios through the real payment path and compares the engine with the model on its own.

**Payment-grade engineering** (3)

- A double-entry, append-only, hash-chained journal of every money movement, and a hash-chained audit log of every administrator decision; nightly reconciliation proves the books balance. See `docs/LEDGER.md`.
- Idempotency keys, so a retried payment never applies twice; two-person approval for large releases and refunds; two-step sign-in with an authenticator app; new-device alerts; live notifications; a retry queue for payments made while the model was down; latency monitoring and a Prometheus endpoint.

**Built for Kenya** (3)

- Wallets in Kenya shillings; M-Pesa deposits by STK push (simulated, or Safaricom's Daraja sandbox); a USSD menu for feature phones; sending money to a phone number; chamas (group savings with majority-approved payouts); and a Swahili interface. See `docs/KENYA.md`.

**The engine as a product** (3)

- A fraud API for other businesses, with API keys, rate limits, signed webhooks and documentation at `/developers.html`. See `docs/API.md`.

**Evidence** (3)

- 65 automated test cases, a load test, model validation on the 2.7 million PaySim payments the model never saw and on a time-based split, and a usability study protocol with the System Usability Scale built in. See `docs/VALIDATION.md` and `docs/USABILITY_STUDY.md`.

## Architecture

| Tier | Technology | Location |
|---|---|---|
| Presentation | HTML, CSS, JavaScript | `src/public/` |
| Application | Node.js, Express.js | `src/` (routes, controllers, models, middleware, services) |
| Data | MySQL 8.0 (InnoDB), 28 tables | `database/schema.sql`, `database/migrations/` |
| Fraud scoring | Python, FastAPI, scikit-learn | `ml/ml/app.py`, `ml/ml/features.py`, `ml/ml/training.py` |

The Express server calls the scoring service (`POST /score`) for each transfer, withdrawal or bank transfer before it commits, with a 2-second timeout, and combines the score with the risk engine's signals. If the service is unavailable, the transaction is recorded as `unscored`, the signals alone decide the risk, and a retry queue scores it once the service is back.

| Page | For |
|---|---|
| `/` , `/login.html`, `/register.html` | Everyone |
| `/dashboard.html` | The wallet |
| `/admin.html` | The administrator console: overview, alerts, disputes, network, models, ledger, audit log, system, fraud API clients, attack lab, usability results |
| `/developers.html` | Fraud API documentation |
| `/survey.html` | The usability questionnaire |
| `/ussd.html` | USSD simulator for a signed-in user, dialling from their own linked number (with `USSD_SIMULATOR=1`) |

## Tested environment

The system was developed and tested on one Windows 11 laptop (AMD Ryzen 5 5625U, 7.5 GB RAM).

| Software | Tested version |
|---|---|
| Node.js / npm | 24.20.0 / 11.19.0 |
| Python | 3.12.10 |
| MySQL Community Server | 8.0.46 |
| express, express-session, bcrypt, mysql2 | 5.2.1, 1.19.0, 6.0.0, 3.24.4 |
| scikit-learn, pandas, NumPy, joblib | 1.9.1, 3.0.5, 2.5.3, 1.6.0 |
| FastAPI, Uvicorn | 0.143.0, 0.54.0 |

Exact Node.js package versions are recorded in `package-lock.json`.

## Running it with Docker

With Docker installed and `DB_PASSWORD`, `SESSION_SECRET` and `ML_ADMIN_TOKEN` set in `.env`:

```
docker compose up --build -d
docker compose exec web node scripts/create-admin.js "Your Name" you@example.com "a-strong-password"
```

Then open http://localhost:3000. `docs/DEPLOYMENT.md` covers this and deployment to a server with HTTPS.

## Running it locally without Docker

### 1. Install

```
git clone https://github.com/Makau-1/wallet-fraud-system.git
cd wallet-fraud-system
git checkout v3-platform
npm install
cd ml
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

### 2. Database

Create an empty database named `wallet_fraud_db` (in MySQL Workbench, or `CREATE DATABASE wallet_fraud_db;`), set up `.env` (step 3), then from the project root:

```
node scripts/migrate.js
```

This needs no `mysql` command-line tool. On an empty database it creates every table; on an existing version 1 or 2 database it applies only what is missing, records what it applied, and opens the double-entry journal with the existing balances. `node scripts/migrate.js --status` lists the migrations. Creating the journal's triggers needs an account allowed to create them, such as `root`.

(Loading `database/schema.sql` directly, as Docker does, gives the same result.)

### 3. Environment

Create a `.env` file in the project root (it is not committed):

```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your-mysql-password
DB_NAME=wallet_fraud_db
SESSION_SECRET=any-long-random-string
ML_URL=http://127.0.0.1:8000
PORT=3000
RISK_MODE=advisory
ATTACK_LAB=0
ML_ADMIN_TOKEN=another-long-random-string
USSD_SIMULATOR=1
```

`RISK_MODE` is `advisory` (flag only) or `enforce` (PIN challenge, scam check, holds and cooling-off). `ATTACK_LAB=1` switches on the attack lab and `USSD_SIMULATOR=1` the USSD simulator page. `.env.example` lists every setting with its default, including M-Pesa, two-step sign-in and the payment-protection thresholds.

### 4. Model

The trained model (`ml/fraud_model.pkl`) is not committed. Build it from the `ml` folder with `venv\Scripts\python.exe train_model.py`, which trains the same Random Forest as `ml/model_comparison.ipynb` (same data, split, parameters and seed) in a few seconds. Running the notebook to the end also saves it. The processed dataset and the training and test splits are committed in `ml/data/` (tracked deliberately despite the general `*.csv` rule), so the raw PaySim file is needed only to repeat the preprocessing. The raw dataset is available from Kaggle (https://www.kaggle.com/datasets/ealaxi/paysim1) with a free account.

### 5. Start the services

Scoring service, from the `ml` folder (in PowerShell, `$env:ML_ADMIN_TOKEN = "the same value as in .env"` first, so the console can retrain and promote models):

```
venv\Scripts\python.exe -m uvicorn ml.app:app --port 8000
```

Web application, in a second terminal from the project root:

```
npm run dev
```

### 6. Health checks

| Check | Expected |
|---|---|
| http://127.0.0.1:8000/health | `status: ok`, model `random_forest`, threshold `0.5` |
| http://localhost:3000/api | "Wallet Fraud System API is running" |
| http://localhost:3000/api/status | wallet, database and scoring all `operational`; shows the risk mode |

Then open http://localhost:3000.

### 7. Administrator account

Register an account through the website, then give it the administrator role:

```
node scripts/create-admin.js your-admin-email@example.com
```

Signing in with that account opens the administrator console. Under **Security** in the wallet, or when the console asks, set up two-step sign-in with an authenticator app.

## Testing

With both services running, from the project root:

```
node tests/run-tests.js            # TC-01 to TC-15 and TC-17 to TC-26 (advisory mode)
node tests/run-tests.js --tc16     # TC-16, with the scoring service stopped
```

Version 2 and 3 cases. Set `RISK_MODE=enforce`, `ATTACK_LAB=1` and `USSD_SIMULATOR=1` in `.env`, restart the website, then:

```
node tests/run-v2-tests.js         # TC-27 to TC-40
node tests/run-v3-tests.js         # TC-41 to TC-65
node scripts/reconcile.js          # the books must balance after every run
```

In advisory mode the cases that need enforcement are reported as not run. Set `RISK_MODE` back to `advisory` before running `run-tests.js` again, because TC-13 and TC-14 expect flagged transfers to complete.

Every push runs all the suites, a short load test and reconciliation through GitHub Actions (`.github/workflows/tests.yml`).

Other checks:

```
node scripts/load-test.js 50 60                  # load test; results in tests/results/
cd ml
venv\Scripts\python.exe -m tests.test_features  # live features match training features
venv\Scripts\python.exe validate_external.py    # needs the raw PaySim file; see docs/VALIDATION.md
```

Results are written to `tests/results/`. The test runner creates its own accounts ending in `@test.securewallet`; remove them afterwards with:

```
node tests/run-tests.js --cleanup
```

The results for version 1.0 reported in Chapter 5 of the project report (10 November 2026) are kept unchanged in `tests/results/results.md` and `results-tc16.md`: 26 of 26 test cases passed and the feature check found 0 mismatches in 200 records. The test runner writes a new run to the same files, so commit `results.md` only from that run. The version 3 runs (all 65 cases passing) are listed in `docs/VALIDATION.md`.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/migrate.js` | Create or upgrade the database |
| `scripts/create-admin.js` | Create an administrator, or promote an existing account |
| `scripts/reconcile.js` | Check that the books balance; exits with an error if not |
| `scripts/load-test.js` | Load test with simulated users |
| `scripts/api-demo.js` | Play a fraud API client: normal payments, then a takeover |
| `scripts/webhook-receiver.js` | A webhook receiver that verifies signatures |
| `ml/train_model.py` | Train the model |
| `ml/validate_external.py` | Validate the model on unseen PaySim payments and a time split |

## API

The main endpoints. Every route is in `src/routes/`, and the fraud API is described in `docs/API.md` and at `/developers.html`.

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/mfa` | Public (`/login` answers 202 when a two-step code is needed) |
| POST, GET | `/api/auth/logout`, `/api/auth/me` | Signed in |
| POST | `/api/auth/pin`, `/api/auth/2fa/setup`, `/enable`, `/disable` | User |
| GET | `/api/status` | Public |
| GET | `/api/wallet/balance`, `/api/wallet/history`, `/api/wallet/recipient?email=` | User |
| POST | `/api/wallet/deposit`, `/withdraw`, `/transfer` | User (scored; accepts an `Idempotency-Key` header) |
| POST | `/api/wallet/transactions/:id/dispute`, `/cancel` | User ("This wasn't me"; cancel during cooling-off) |
| POST | `/api/payments/bank`, `/api/payments/bill` | User |
| GET, POST | `/api/savings…`, `/api/loans…`, `/api/requests…` | User |
| GET, POST, PUT | `/api/me/phone`, `/language`, `/devices`, `/freeze`, `/export` | User (account and security) |
| GET, POST | `/api/notifications`, `/api/reports`, `/api/chamas…`, `/api/mpesa/stk`, `/api/survey/sus` | User |
| GET | `/api/events` | User (live updates, Server-Sent Events) |
| POST | `/api/mpesa/callback/:token`, `/api/ussd/callback/:token` | Safaricom, Africa's Talking |
| POST, GET | `/api/v1/assess`, `/api/v1/assessments/:id…`, `/api/v1/usage` | Fraud API key |
| GET, POST, PATCH | `/api/admin/…` (alerts, disputes, network, models, ledger, audit, system, API clients, lab, survey) | Administrator |
| GET | `/metrics` | Administrator or `METRICS_TOKEN` |

A scored payment answers HTTP 428 with `challenge: "pin"` when the PIN is needed, or `challenge: "purpose"` when the scam check asks what it is for; the client sends the same request again with `pin` or `purpose`.

## Model

Random Forest (200 trees, maximum depth 12, balanced class weights) on seven features: amount, the sender's and recipient's balances before and after the transaction, the encoded transaction type, and an engineered `balance_discrepancy`. On a test set at about 1% fraud it achieved precision 0.965, recall 1.000 and F1 0.982, and outperformed two Isolation Forest baselines. Results were measured on simulated data; performance on real wallet traffic has not been measured. See `ml/model_comparison.ipynb` and `ml/ml/model_selection_decision.txt`. From version 3 the model can be retrained from analysts' decisions; each assessment records the version of the model that made it.

## Branches and versions

- `master`: released version, tagged `v1.0` for submission.
- `develop`: integration branch.
- `v2-risk-engine`: version 2.
- `v3-platform`: version 3, described above (includes version 2).
- `feature/auth-module`, `feature/wallet-core`: module branches, merged into `develop`.
- Tags `sprint-1-complete` and `sprint-2-complete` mark sprint milestones.

## Access and licence

This repository is shared for academic assessment at Strathmore University. All rights reserved by the author; no licence is granted for reuse beyond review and assessment. The PaySim dataset is the work of its authors (Lopez-Rojas et al., 2016); only the processed sample used for training is included here, and the full log must be downloaded from Kaggle.
