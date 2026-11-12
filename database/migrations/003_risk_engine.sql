-- SecureWallet v2: transaction PIN for step-up verification.
-- Run once against wallet_fraud_db:
--   Windows PowerShell:
--     mysql -u root -p wallet_fraud_db -e "source database/migrations/003_risk_engine.sql"
--   macOS or Linux:
--     mysql -u root -p wallet_fraud_db < database/migrations/003_risk_engine.sql
-- Held transactions use the existing transactions.status values:
--   pending = held for review, completed = released, failed = reversed.

ALTER TABLE `users`
  ADD COLUMN `pin_hash` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  ADD COLUMN `pin_failed_attempts` int unsigned NOT NULL DEFAULT '0',
  ADD COLUMN `pin_locked_until` datetime DEFAULT NULL;
