# SecureWallet

A simulated web-based digital wallet with real-time, Random Forest-based fraud detection. Users deposit, withdraw and send money; every transfer and withdrawal is scored by a machine learning model as it is made, and transactions scoring 0.50 or above are raised as alerts for an administrator to confirm as fraud or dismiss. Flagged transactions are not blocked.

No real money moves. The model is trained on PaySim, a synthetic mobile money dataset.

## Architecture

| Tier | Technology | Location |
|---|---|---|
| Presentation | HTML, CSS, JavaScript | `src/public/` |
| Application | Node.js, Express.js | `src/` (routes, controllers, models, middleware, services) |
| Data | MySQL (InnoDB) | schema in `database/schema.sql` |
| Fraud scoring | Python, FastAPI, scikit-learn | `ml/ml/app.py`, `ml/ml/features.py` |

The Express server calls the scoring service (`POST /score`) after each transfer or withdrawal commits, with a 2-second timeout. If the service is unavailable, the transaction still completes and is recorded as `unscored`.

## Running it locally

### 1. Database

Create a database and load the schema:

```sql
CREATE DATABASE wallet_fraud_db;
```
```
mysql -u root -p wallet_fraud_db < database/schema.sql
```

### 2. Environment

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

### 3. Fraud scoring service

The trained model (`ml/fraud_model.pkl`) is not committed. Generate it by running `ml/model_comparison.ipynb` to the end, which saves the bundle. Then:

```
cd ml
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn ml.app:app --port 8000
```

Check it at http://127.0.0.1:8000/health and http://127.0.0.1:8000/docs.

### 4. Web application

In a second terminal, from the project root:

```
npm install
npm run dev
```

Open http://localhost:3000.

### 5. Administrator account

Register an account through the website, then give it the administrator role:

```sql
UPDATE users SET role = 'admin' WHERE email = 'your-admin-email@example.com';
```

Signing in with that account opens the fraud review screen.

## API

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| POST | `/api/auth/logout` | Signed in |
| GET | `/api/auth/me` | Signed in |
| GET | `/api/wallet/balance` | User |
| POST | `/api/wallet/deposit` | User |
| POST | `/api/wallet/withdraw` | User (scored) |
| POST | `/api/wallet/transfer` | User (scored) |
| GET | `/api/wallet/history?page=1&limit=20` | User |
| GET | `/api/admin/fraud-alerts?status=pending` | Administrator |
| PATCH | `/api/admin/fraud-alerts/:id/status` | Administrator |

## Model

Random Forest (200 trees, maximum depth 12, balanced class weights) on seven features: amount, the sender's and recipient's balances before and after the transaction, the encoded transaction type, and an engineered `balance_discrepancy`. On a test set at about 1% fraud it achieved precision 0.965, recall 1.000 and F1 0.982, and outperformed two Isolation Forest baselines. See `ml/model_comparison.ipynb` and `ml/ml/model_selection_decision.txt`.
