# Deploying SecureWallet

This guide covers two ways to run the whole system with Docker: on your own computer, and on a server with HTTPS. Docker starts the database, the fraud scoring service and the website together, so nothing has to be installed by hand.

## 1. On your own computer

Install Docker Desktop, then from the project folder:

1. Make sure the `.env` file has a database password and a session secret. Copy `.env.example` to `.env` if you do not have one.

   ```
   DB_PASSWORD=choose-a-password
   SESSION_SECRET=a-long-random-string
   ```

2. Build and start everything:

   ```
   docker compose up --build -d
   ```

   The first build takes a few minutes: it installs the Python packages and trains the model from the committed data.

3. Open http://localhost:3000 and create an administrator:

   ```
   docker compose exec web node scripts/create-admin.js "Your Name" you@example.com "a-strong-password"
   ```

To see the logs run `docker compose logs -f`, and to stop run `docker compose down`. The database is kept in a Docker volume; `docker compose down -v` deletes it.

If you already run MySQL and the website directly on your computer, that still works exactly as before. Docker is an additional way to run the system, not a replacement.

## 2. On a server, with HTTPS

You need a Linux server (any provider's smallest virtual machine with 2 GB of memory is enough) and a domain name whose DNS A record points at the server's address.

1. Install Docker on the server and open ports 80 and 443 in its firewall.

2. Copy the project to the server:

   ```
   git clone https://github.com/Makau-1/wallet-fraud-system.git
   cd wallet-fraud-system
   git checkout v2-risk-engine
   ```

   The last line is needed until version 2 has been merged into the default branch.

3. Create `.env` on the server. Use new values, not the ones from your computer:

   ```
   DB_PASSWORD=a-strong-database-password
   SESSION_SECRET=output-of-the-command-below
   DOMAIN=wallet.your-domain.com
   ```

   Generate the secret with `openssl rand -hex 32`.

4. Start the system:

   ```
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```

   Caddy obtains an HTTPS certificate from Let's Encrypt for the domain and renews it automatically. The site is then at `https://wallet.your-domain.com`.

5. Create the administrator account:

   ```
   docker compose exec web node scripts/create-admin.js "Your Name" you@example.com "a-strong-password"
   ```

In production the website runs with `NODE_ENV=production`, which makes the session cookie HTTPS-only and adds the Strict-Transport-Security header. The production file always runs the risk engine in `enforce` mode with the attack lab off, whatever `.env` says.

### Updating the server

```
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### Applying database changes to an existing database

`database/schema.sql` runs only when the database is first created. For a database that already has data, apply the migration files instead, for example:

```
docker compose exec db sh /dbtools/apply-migration.sh 003_risk_engine.sql
```

## What is and is not production-ready

This is a simulated wallet; it never moves real money. The deployment gives it HTTPS, secure cookies, security headers, a sign-in rate limit and a database that survives restarts. Known limits:

- Sessions are kept in the web server's memory, so users are signed out when the web container restarts, and the site cannot run as several copies behind a load balancer. A session store such as Redis would remove this limit.
- The sign-in rate limit and the queue that processes one payment at a time for each sender are also kept in memory, so they too assume a single web process.
- There are no automatic database backups. Take one with `docker compose exec db sh /dbtools/backup.sh` followed by `docker compose cp db:/tmp/backup.sql backup.sql`.
- The attack lab creates accounts and transactions. Keep `ATTACK_LAB=0` on any public deployment; the production file forces it off.
