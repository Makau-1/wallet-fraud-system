# Deploying SecureWallet

This guide covers two ways to run the whole system with Docker: on your own computer, and on a server with HTTPS. Docker starts the database, the fraud scoring service and the website together, so nothing has to be installed by hand.

## 1. On your own computer

Install Docker Desktop, then from the project folder:

1. Make sure the `.env` file has a database password, a session secret and a token for the scoring service. Copy `.env.example` to `.env` if you do not have one.

   ```
   DB_PASSWORD=choose-a-password
   SESSION_SECRET=a-long-random-string
   ML_ADMIN_TOKEN=another-long-random-string
   ```

   The other version 3 settings in `.env.example` (M-Pesa, USSD, scam check, two-person threshold) are optional and have sensible defaults.

2. Build and start everything:

   ```
   docker compose up --build -d
   ```

   The first build takes a few minutes: it installs the Python packages and trains the model from the committed data.

3. Open http://localhost:3000 and create an administrator:

   ```
   docker compose exec web node scripts/create-admin.js "Your Name" you@example.com "a-strong-password"
   ```

To see the logs run `docker compose logs -f`, and to stop run `docker compose down`. The database and the scoring service's models are kept in Docker volumes, so they survive restarts and rebuilds; `docker compose down -v` deletes them.

If you already run MySQL and the website directly on your computer, that still works exactly as before. Docker is an additional way to run the system, not a replacement.

## 2. On a server, with HTTPS

You need a Linux server (any provider's smallest virtual machine with 2 GB of memory is enough) and a domain name whose DNS A record points at the server's address.

1. Install Docker on the server and open ports 80 and 443 in its firewall.

2. Copy the project to the server:

   ```
   git clone https://github.com/Makau-1/wallet-fraud-system.git
   cd wallet-fraud-system
   git checkout v3-platform
   ```

   The last line is needed until version 3 has been merged into the default branch.

3. Create `.env` on the server. Use new values, not the ones from your computer:

   ```
   DB_PASSWORD=a-strong-database-password
   SESSION_SECRET=output-of-the-command-below
   ML_ADMIN_TOKEN=another-output-of-the-command
   DOMAIN=wallet.your-domain.com
   PUBLIC_URL=https://wallet.your-domain.com
   ```

   Generate each secret with `openssl rand -hex 32`. For the real M-Pesa sandbox, also set `MPESA_MODE=sandbox`, the four Daraja values and `MPESA_CALLBACK_TOKEN`; for a live USSD code, set `USSD_CALLBACK_TOKEN` and give Africa's Talking the callback address `https://wallet.your-domain.com/api/ussd/callback/<that token>`.

4. Start the system:

   ```
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```

   Caddy obtains an HTTPS certificate from Let's Encrypt for the domain and renews it automatically. The site is then at `https://wallet.your-domain.com`.

5. Create the administrator account:

   ```
   docker compose exec web node scripts/create-admin.js "Your Name" you@example.com "a-strong-password"
   ```

6. Sign in as the administrator. The production file requires administrators to use two-step sign-in (`ADMIN_2FA=required`), so the console first shows a QR code: scan it with an authenticator app (Google Authenticator, Microsoft Authenticator or similar) and enter the six-digit code. From then on, signing in asks for a code after the password.

In production the website runs with `NODE_ENV=production`, which makes the session cookie HTTPS-only, adds the Strict-Transport-Security header, and requires webhook addresses to use HTTPS on public networks. The production file always runs the risk engine in `enforce` mode with the attack lab and the USSD simulator off, whatever `.env` says. Caddy passes the live-update stream (`/api/events`) through without buffering or compression, so notifications arrive at once.

### Monitoring

`GET /metrics` gives request, model and payment latencies (median, 95th and 99th percentiles) and counts in the Prometheus text format, for an administrator's session or with `Authorization: Bearer <METRICS_TOKEN>`. The same figures are on the console's **System** page. The books are reconciled every night at `RECONCILE_HOUR`; run one by hand with `docker compose exec web node scripts/reconcile.js`.

### Updating the server

```
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### Applying database changes to an existing database

`database/schema.sql` runs only when the database is first created. For a database that already has data, apply the migrations it has not had yet:

```
docker compose exec web node scripts/migrate.js
```

It records what it has applied in a `schema_migrations` table, so it is safe to run again, and the first time it opens the double-entry journal with the existing balances. Without Docker, run `node scripts/migrate.js` from the project folder; use an account that may create triggers (for example `DB_USER=root`).

## What is and is not production-ready

This is a simulated wallet; it never moves real money. The deployment gives it HTTPS, secure cookies, security headers, a sign-in rate limit and a database that survives restarts. Known limits:

- Sessions are kept in the web server's memory, so users are signed out when the web container restarts, and the site cannot run as several copies behind a load balancer. A session store such as Redis would remove this limit.
- The sign-in rate limit, the queue that processes one payment at a time for each sender, the fraud API's rate limiter, the live-update connections, the latency figures and the background workers (cooling-off release, webhook retries, scoring retries, nightly reconciliation) are also in the web process, so they too assume a single web process.
- M-Pesa runs in simulator mode unless Daraja credentials are provided, and the Daraja sandbox is a test system: no real money moves either way. Going live with Safaricom needs a business shortcode and their approval.
- There are no automatic database backups. Take one with `docker compose exec db sh /dbtools/backup.sh` followed by `docker compose cp db:/tmp/backup.sql backup.sql`.
- The attack lab creates accounts and transactions. Keep `ATTACK_LAB=0` on any public deployment; the production file forces it off.
