-- SecureWallet: money services (savings goals, loans, money requests).
-- Run once against wallet_fraud_db:
--   Windows PowerShell:
--     mysql -u root -p wallet_fraud_db -e "source database/migrations/002_money_services.sql"
--   macOS or Linux:
--     mysql -u root -p wallet_fraud_db < database/migrations/002_money_services.sql
-- Every movement of money for these services is still written to the
-- transactions table; these tables hold each service's own state.

CREATE TABLE IF NOT EXISTS `savings_vaults` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `wallet_id` bigint unsigned NOT NULL,
  `name` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_amount` decimal(18,2) DEFAULT NULL,
  `balance` decimal(18,2) NOT NULL DEFAULT '0.00',
  `locked_until` date NOT NULL,
  `status` enum('active','closed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `closed_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_vault_wallet` (`wallet_id`, `status`),
  CONSTRAINT `fk_vault_wallet` FOREIGN KEY (`wallet_id`) REFERENCES `wallets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `loans` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `wallet_id` bigint unsigned NOT NULL,
  `principal` decimal(18,2) NOT NULL,
  `fee` decimal(18,2) NOT NULL,
  `amount_due` decimal(18,2) NOT NULL,
  `amount_repaid` decimal(18,2) NOT NULL DEFAULT '0.00',
  `status` enum('active','repaid') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `due_date` date NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `repaid_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_loan_wallet` (`wallet_id`, `status`),
  CONSTRAINT `fk_loan_wallet` FOREIGN KEY (`wallet_id`) REFERENCES `wallets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `money_requests` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `requester_wallet_id` bigint unsigned NOT NULL,
  `payer_wallet_id` bigint unsigned NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `note` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('pending','paid','declined','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `transaction_id` bigint unsigned DEFAULT NULL,
  `min_transaction_id` bigint unsigned NOT NULL DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `responded_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_request_tx` (`transaction_id`),
  KEY `idx_request_payer` (`payer_wallet_id`, `status`),
  KEY `idx_request_requester` (`requester_wallet_id`, `status`),
  CONSTRAINT `fk_request_requester` FOREIGN KEY (`requester_wallet_id`) REFERENCES `wallets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_request_payer` FOREIGN KEY (`payer_wallet_id`) REFERENCES `wallets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
