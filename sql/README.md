# MySQL schema

## 1. Create database (optional)

```sql
CREATE DATABASE pos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pos;
```

## 2. Run the schema

Open **`schema_mysql.sql`** in phpMyAdmin / MySQL Workbench and execute it, or:

```bash
mysql -u root -p pos < sql/schema_mysql.sql
```

## 3. Backend `.env` (enables MySQL for reset tokens)

If **`DB_HOST`** (or legacy **`MYSQL_HOST`**) is set, the app stores rows in **`password_resets`** instead of `data/password-reset-tokens.json`.

```env
DB_HOST=localhost
DB_USER=root
DB_PASS=yourpassword
DB_NAME=pos_db
# optional: DB_PORT=3306
```

Legacy names still work: `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.

Restart the backend after changing `.env`.

## 4. `users` table

Login for this POS app still uses **`data/users.json`**. On successful reset, the app updates **JSON** and, if MySQL is enabled, runs **`UPDATE users`** when a matching email exists in the **`users`** table (optional dual write).

To mirror accounts into MySQL, insert rows with the same emails and bcrypt hashes (or import later).

## 5. `password_resets.token`

The column stores the **SHA-256 hex hash** of the secret from the reset URL, not the raw token.
