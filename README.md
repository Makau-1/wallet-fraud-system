# SecureWallet

A simulated web-based digital wallet with real-time, Random Forest-based fraud detection, built as a final-year Computer Science project at Strathmore University (Alex Makau, 165926; supervisor Dr Esther Khakata).

**Problem.** Large payment platforms score transactions with machine learning, but those capabilities are proprietary, while smaller and educational wallets rely on fixed rules or have no fraud detection. SecureWallet shows, in a form that can be inspected and reproduced, how a machine learning model can be built into a wallet's transaction pipeline, from the moment a transaction is made to the decision of a human reviewer.

**What it does.** Users deposit, withdraw and send money, send money to a bank, pay bills and shops, buy airtime, save in locked savings goals, borrow and repay loans, and request money from each other. Every transfer, withdrawal and bank transfer is scored by the model as it is made. Transactions scoring 0.50 or above are raised as alerts for an administrator to confirm as fraud or dismiss. Flagged transactions are not blocked.

No real money moves. The model is trained on PaySim, a synthetic mobile money dataset.

## Architecture

| Tier | Technology | Location |
|---|---|---|
| Presentation | HTML, CSS, JavaScript | `src/public/` |
| Application | Node.js, Express.js | `src/` (routes, controllers, models, middleware, services) |
| Data | MySQL 8.0 (InnoDB), seven tables | `database/schema.sql`, `database/migrations/` |
| Fraud scoring | Python, FastAPI, scikit-learn | `ml/ml/app.py`, `ml/ml/features.py` |

The Express server calls the scoring service (`POST /score`) after each transfer, withdrawal or bank transfer commits, with a 2-second timeout. If the service is unavailable, the transaction still completes and is recorded as `unscored`.

## Tested environment

The system was developed and tested as a local prototype on one Windows 11 laptop (AMD Ryzen 5 5625U, 7.5 GB RAM). It is not deployed publicly.

| Software | Tested version |
|---|---|
| Node.js / npm | 24.20.0 / 11.19.0 |
| Python | 3.12.10 |
| MySQL Community Server | 8.0.46 |
| express, express-session, bcrypt, mysql2 | 5.2.1, 1.19.0, 6.0.0, 3.24.4 |
| scikit-learn, pandas, NumPy, joblib | 1.9.1, 3.0.5, 2.5.3, 1.6.0 |
| FastAPI, Uvicorn | 0.143.0, 0.54.0 |

Exact Node.js package versions are recorded in `package-lock.json`.

## Running it locally

### 1. Install

```
git clone https://github.com/Makau-1/wallet-fraud-system.git
cd wallet-fraud-system
npm install
cd ml
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

### 2. Database

Create the database and load the schema, which creates all seven tables:

```sql
CREATE DATABASE wallet_fraud_db;
```
```
mysql -u root -p wallet_fraud_db -e "source database/schema.sql"
```

To upgrade a database created before the money services were added, run the migration instead of the full schema:

```
mysql -u root -p wallet_fraud_db -e "source database/migrations/002_money_services.sql"
```

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
```

### 4. Model

The trained model (`ml/fraud_model.pkl`) is not committed. Generate it by running `ml/model_comparison.ipynb` to the end, which saves the bundle. The processed dataset and the training and test splits are committed in `ml/data/` (tracked deliberately despite the general `*.csv` rule), so the raw PaySim file is needed only to repeat the preprocessing. The raw dataset is available from Kaggle (https://www.kaggle.com/datasets/ealaxi/paysim1) with a free account.

### 5. Start the services

Scoring service, from the `ml` folder:

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
| http://localhost:3000/api/status | wallet, database and scoring all `operational` |

Then open http://localhost:3000.

### 7. Administrator account

Register an account through the website, then give it the administrator role:

```sql
UPDATE users SET role = 'admin' WHERE email = 'your-admin-email@example.com';
```

Signing in with that account opens the fraud review page.

## Testing

With both services running, from the project root:

```
node tests/run-tests.js            # TC-01 to TC-15 and TC-17 to TC-26
```

Stop the scoring service, then:

```
node tests/run-tests.js --tc16     # TC-16: transfer while scoring is unavailable
```

Feature consistency check, from the `ml` folder:

```
venv\Scripts\python.exe -m tests.test_features
```

Results are written to `tests/results/`. The test runner creates its own accounts ending in `@test.securewallet`; remove them afterwards with:

```
node tests/run-tests.js --cleanup
```

The committed results in `tests/results/` are from the run reported in Chapter 5 of the project report (10 November 2026): 26 of 26 test cases passed and the feature check found 0 mismatches in 200 records.

## API

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Public |
| POST, GET | `/api/auth/logout`, `/api/auth/me` | Signed in |
| GET | `/api/status` | Public |
| GET | `/api/wallet/balance`, `/api/wallet/history` | User |
| POST | `/api/wallet/deposit` | User |
| POST | `/api/wallet/withdraw`, `/api/wallet/transfer` | User (scored) |
| POST | `/api/payments/bank` | User (scored) |
| POST | `/api/payments/bill` | User |
| GET, POST | `/api/savings`, `/api/savings/:id/deposit`, `/api/savings/:id/withdraw` | User |
| GET, POST | `/api/loans`, `/api/loans/repay` | User |
| GET, POST | `/api/requests`, `/api/requests/:id/pay`, `/decline`, `/cancel` | User |
| GET | `/api/admin/fraud-alerts?status=pending` | Administrator |
| PATCH | `/api/admin/fraud-alerts/:id/status` | Administrator |

## Model

Random Forest (200 trees, maximum depth 12, balanced class weights) on seven features: amount, the sender's and recipient's balances before and after the transaction, the encoded transaction type, and an engineered `balance_discrepancy`. On a test set at about 1% fraud it achieved precision 0.965, recall 1.000 and F1 0.982, and outperformed two Isolation Forest baselines. Results were measured on simulated data; performance on real wallet traffic has not been measured. See `ml/model_comparison.ipynb` and `ml/ml/model_selection_decision.txt`.

## Branches and versions

- `master`: released version, tagged `v1.0` for submission.
- `develop`: integration branch.
- `feature/auth-module`, `feature/wallet-core`: module branches, merged into `develop`.
- Tags `sprint-1-complete` and `sprint-2-complete` mark sprint milestones.

## Access and licence

This repository is shared for academic assessment at Strathmore University. All rights reserved by the author; no licence is granted for reuse beyond review and assessment. The PaySim dataset is the work of its authors (Lopez-Rojas et al., 2016) and is not redistributed here.
