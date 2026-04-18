-- MySQL / MariaDB — run in phpMyAdmin, MySQL Workbench, or: mysql -u root -p < sql/schema_mysql.sql

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL
);

-- Reset links: store SHA-256 hex (64 chars) of the secret token in `token` — not the raw token from the URL.
CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  token VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_password_resets_email (email),
  INDEX idx_password_resets_token (token),
  INDEX idx_password_resets_expires (expires_at)
);
