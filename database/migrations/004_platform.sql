-- SecureWallet v3: platform features.
-- Apply with:  node scripts/migrate.js
--
-- Adds the double-entry journal, the audit log, reconciliation runs,
-- idempotency keys, notifications, devices, two-factor sign-in, account
-- freezes, disputes, recipient reports, M-Pesa requests, chamas, the fraud
-- API (clients, keys, events, webhooks), usability survey responses and
-- alert notes. Wallets now default to Kenya shillings.

-- ---------------------------------------------------------------- users
ALTER TABLE `users`
  ADD COLUMN `phone` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  ADD COLUMN `language` enum('en','sw') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'en',
  ADD COLUMN `frozen_at` datetime DEFAULT NULL,
  ADD COLUMN `frozen_reason` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  ADD COLUMN `totp_secret` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  ADD COLUMN `totp_enabled` tinyint(1) NOT NULL DEFAULT '0',
  ADD COLUMN `totp_last_step` bigint DEFAULT NULL,
  ADD UNIQUE KEY `uq_users_phone` (`phone`);

-- ---------------------------------------------------------------- currency
-- The wallet is simulated, so this relabels balances as Kenya shillings;
-- no conversion is involved.
ALTER TABLE `wallets` ALTER `currency` SET DEFAULT 'KES';
ALTER TABLE `transactions` ALTER `currency` SET DEFAULT 'KES';
UPDATE `wallets` SET `currency` = 'KES' WHERE `currency` = 'USD';
UPDATE `transactions` SET `currency` = 'KES' WHERE `currency` = 'USD';

-- ---------------------------------------------------------------- alerts
ALTER TABLE `fraud_alerts`
  ADD COLUMN `proposed_status` enum('confirmed_fraud','cleared') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  ADD COLUMN `proposed_by` bigint unsigned DEFAULT NULL,
  ADD COLUMN `proposed_at` datetime DEFAULT NULL,
  ADD COLUMN `assigned_to` bigint unsigned DEFAULT NULL;

CREATE TABLE IF NOT EXISTS `alert_notes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `alert_id` bigint unsigned NOT NULL,
  `author_id` bigint unsigned DEFAULT NULL,
  `note` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_note_alert` (`alert_id`),
  CONSTRAINT `fk_note_alert` FOREIGN KEY (`alert_id`) REFERENCES `fraud_alerts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- journal
-- Every movement of money is an entry whose lines add up to zero. Account
-- names: wallet:<id>, savings:<vault id>, loan:<loan id>, held:<transaction
-- id>, chama:<id>, external:<name>, equity:opening.
CREATE TABLE IF NOT EXISTS `journal_entries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `created_at` datetime(3) NOT NULL,
  `kind` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `transaction_id` bigint unsigned DEFAULT NULL,
  `memo` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `prev_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_journal_tx` (`transaction_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `journal_lines` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `entry_id` bigint unsigned NOT NULL,
  `account` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_line_entry` (`entry_id`),
  KEY `idx_line_account` (`account`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The latest hash of each chain. Locking a row serialises appends to that
-- chain, so every record links to the one before it.
CREATE TABLE IF NOT EXISTS `chain_heads` (
  `name` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_id` bigint unsigned NOT NULL DEFAULT '0',
  `last_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `opened_at` datetime DEFAULT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `chain_heads` (`name`, `last_id`, `last_hash`) VALUES
  ('journal', 0, '0000000000000000000000000000000000000000000000000000000000000000'),
  ('audit', 0, '0000000000000000000000000000000000000000000000000000000000000000');

-- ---------------------------------------------------------------- audit log
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `created_at` datetime(3) NOT NULL,
  `actor_id` bigint unsigned DEFAULT NULL,
  `actor_role` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_type` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `target_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `details` text COLLATE utf8mb4_unicode_ci,
  `ip` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `prev_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_actor` (`actor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The journal and the audit log can only be added to.
DROP TRIGGER IF EXISTS `journal_entries_no_update`;
CREATE TRIGGER `journal_entries_no_update` BEFORE UPDATE ON `journal_entries` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The journal is append-only';
DROP TRIGGER IF EXISTS `journal_entries_no_delete`;
CREATE TRIGGER `journal_entries_no_delete` BEFORE DELETE ON `journal_entries` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The journal is append-only';
DROP TRIGGER IF EXISTS `journal_lines_no_update`;
CREATE TRIGGER `journal_lines_no_update` BEFORE UPDATE ON `journal_lines` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The journal is append-only';
DROP TRIGGER IF EXISTS `journal_lines_no_delete`;
CREATE TRIGGER `journal_lines_no_delete` BEFORE DELETE ON `journal_lines` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The journal is append-only';
DROP TRIGGER IF EXISTS `audit_log_no_update`;
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The audit log is append-only';
DROP TRIGGER IF EXISTS `audit_log_no_delete`;
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The audit log is append-only';

CREATE TABLE IF NOT EXISTS `reconciliation_runs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `started_at` datetime(3) NOT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `trigger_source` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ok` tinyint(1) DEFAULT NULL,
  `summary` text COLLATE utf8mb4_unicode_ci,
  `issues` mediumtext COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- idempotency
CREATE TABLE IF NOT EXISTS `idempotency_keys` (
  `user_id` bigint unsigned NOT NULL,
  `idem_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `request_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status_code` smallint DEFAULT NULL,
  `response` mediumtext COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`, `idem_key`),
  KEY `idx_idem_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- notifications
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `kind` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `body` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `read_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notif_user` (`user_id`, `read_at`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- devices
CREATE TABLE IF NOT EXISTS `user_devices` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `device_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `first_seen` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_ip` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `session_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device` (`user_id`, `device_hash`),
  CONSTRAINT `fk_device_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- disputes and reports
CREATE TABLE IF NOT EXISTS `disputes` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `transaction_id` bigint unsigned NOT NULL,
  `reason` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('open','upheld','rejected') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'open',
  `recovered_amount` decimal(18,2) DEFAULT NULL,
  `proposed_status` enum('upheld','rejected') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `proposed_by` bigint unsigned DEFAULT NULL,
  `proposed_at` datetime DEFAULT NULL,
  `decided_by` bigint unsigned DEFAULT NULL,
  `decided_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dispute_tx` (`transaction_id`),
  KEY `idx_dispute_status` (`status`),
  CONSTRAINT `fk_dispute_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dispute_tx` FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `recipient_reports` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `reporter_id` bigint unsigned NOT NULL,
  `reported_id` bigint unsigned NOT NULL,
  `reason` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `details` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_report_pair` (`reporter_id`, `reported_id`),
  KEY `idx_report_reported` (`reported_id`),
  CONSTRAINT `fk_report_reporter` FOREIGN KEY (`reporter_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_report_reported` FOREIGN KEY (`reported_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- M-Pesa
CREATE TABLE IF NOT EXISTS `mpesa_requests` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `wallet_id` bigint unsigned NOT NULL,
  `phone` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `mode` enum('simulator','sandbox') COLLATE utf8mb4_unicode_ci NOT NULL,
  `merchant_request_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `checkout_request_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('pending','success','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `result_code` int DEFAULT NULL,
  `result_desc` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `receipt` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `transaction_id` bigint unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_checkout` (`checkout_request_id`),
  KEY `idx_mpesa_user` (`user_id`),
  CONSTRAINT `fk_mpesa_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- chamas
CREATE TABLE IF NOT EXISTS `chamas` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `purpose` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `goal_amount` decimal(18,2) DEFAULT NULL,
  `contribution_amount` decimal(18,2) DEFAULT NULL,
  `balance` decimal(18,2) NOT NULL DEFAULT '0.00',
  `created_by` bigint unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chama_members` (
  `chama_id` bigint unsigned NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  `role` enum('chair','treasurer','member') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'member',
  `status` enum('invited','active','left') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'invited',
  `invited_by` bigint unsigned DEFAULT NULL,
  `joined_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`chama_id`, `user_id`),
  KEY `idx_chama_member_user` (`user_id`),
  CONSTRAINT `fk_cm_chama` FOREIGN KEY (`chama_id`) REFERENCES `chamas` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cm_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chama_payouts` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `chama_id` bigint unsigned NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `recipient_id` bigint unsigned NOT NULL,
  `reason` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('proposed','paid','rejected') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'proposed',
  `required_approvals` tinyint unsigned NOT NULL,
  `proposed_by` bigint unsigned NOT NULL,
  `transaction_id` bigint unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `decided_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_payout_chama` (`chama_id`, `status`),
  CONSTRAINT `fk_payout_chama` FOREIGN KEY (`chama_id`) REFERENCES `chamas` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chama_payout_votes` (
  `payout_id` bigint unsigned NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  `vote` enum('approve','reject') COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`payout_id`, `user_id`),
  CONSTRAINT `fk_vote_payout` FOREIGN KEY (`payout_id`) REFERENCES `chama_payouts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- fraud API
CREATE TABLE IF NOT EXISTS `api_clients` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `contact_email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `webhook_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `webhook_secret` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `rate_limit_per_minute` int unsigned NOT NULL DEFAULT '120',
  `status` enum('active','suspended') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `client_id` bigint unsigned NOT NULL,
  `prefix` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `label` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` datetime DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_key_hash` (`key_hash`),
  CONSTRAINT `fk_key_client` FOREIGN KEY (`client_id`) REFERENCES `api_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `api_events` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `client_id` bigint unsigned NOT NULL,
  `external_id` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `account_id` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `counterparty_id` varchar(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `type` enum('TRANSFER','CASH_OUT') COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `status` enum('completed','declined','reversed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'completed',
  `model_score` decimal(9,6) DEFAULT NULL,
  `risk` decimal(9,6) DEFAULT NULL,
  `decision` enum('allow','challenge','review') COLLATE utf8mb4_unicode_ci NOT NULL,
  `detail` text COLLATE utf8mb4_unicode_ci,
  `features` text COLLATE utf8mb4_unicode_ci,
  `label` enum('fraud','legit') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `labelled_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_external` (`client_id`, `external_id`),
  KEY `idx_event_account` (`client_id`, `account_id`, `created_at`),
  KEY `idx_event_counterparty` (`client_id`, `counterparty_id`, `created_at`),
  CONSTRAINT `fk_event_client` FOREIGN KEY (`client_id`) REFERENCES `api_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `webhook_deliveries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `client_id` bigint unsigned NOT NULL,
  `event_type` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','delivered','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` int unsigned NOT NULL DEFAULT '0',
  `next_attempt_at` datetime NOT NULL,
  `last_status_code` int DEFAULT NULL,
  `last_error` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `delivered_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_delivery_due` (`status`, `next_attempt_at`),
  CONSTRAINT `fk_delivery_client` FOREIGN KEY (`client_id`) REFERENCES `api_clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- usability survey
CREATE TABLE IF NOT EXISTS `sus_responses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned DEFAULT NULL,
  `role` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `answers` varchar(60) COLLATE utf8mb4_unicode_ci NOT NULL,
  `score` decimal(5,1) NOT NULL,
  `comment` varchar(1000) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
