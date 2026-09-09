
-- Drop in reverse order to avoid foreign key errors when re-running
DROP TABLE IF EXISTS fraud_alerts;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS users;

-- Users table
CREATE TABLE users (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	name VARCHAR(255) DEFAULT NULL,
	email VARCHAR(255) NOT NULL UNIQUE,
	password_hash VARCHAR(255) NOT NULL,
	role ENUM('user','admin') NOT NULL DEFAULT 'user',
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Wallets table: one-to-one with users (user can have one wallet)
CREATE TABLE wallets (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	user_id BIGINT UNSIGNED NOT NULL UNIQUE,
	balance DECIMAL(18,2) NOT NULL DEFAULT 0.00,
	currency CHAR(3) NOT NULL DEFAULT 'USD',
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transactions table: references sender and receiver wallets
CREATE TABLE transactions (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	sender_wallet_id BIGINT UNSIGNED DEFAULT NULL,
	receiver_wallet_id BIGINT UNSIGNED DEFAULT NULL,
	amount DECIMAL(18,2) NOT NULL,
	currency CHAR(3) NOT NULL DEFAULT 'USD',
	status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
	metadata JSON DEFAULT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT fk_tx_sender FOREIGN KEY (sender_wallet_id) REFERENCES wallets(id) ON DELETE SET NULL ON UPDATE CASCADE,
	CONSTRAINT fk_tx_receiver FOREIGN KEY (receiver_wallet_id) REFERENCES wallets(id) ON DELETE SET NULL ON UPDATE CASCADE,
	INDEX idx_sender (sender_wallet_id),
	INDEX idx_receiver (receiver_wallet_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fraud alerts: reference transactions; alert status tracks investigation outcome
CREATE TABLE fraud_alerts (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
	transaction_id BIGINT UNSIGNED NOT NULL,
	alert_type VARCHAR(100) NOT NULL,
	score DECIMAL(5,2) DEFAULT NULL,
	status ENUM('pending','confirmed_fraud','cleared') NOT NULL DEFAULT 'pending',
	notes TEXT DEFAULT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT fk_alert_tx FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE ON UPDATE CASCADE,
	INDEX idx_tx (transaction_id),
	INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


