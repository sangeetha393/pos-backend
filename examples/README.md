# Examples

## `standalone-forgot-password-server.cjs`

Tutorial-style **CommonJS** server (separate from the main TypeScript POS API).

### Fixes vs a minimal tutorial snippet

| Issue | Change |
|--------|--------|
| `sendMail` not awaited | Uses `await` so the response is sent after the email attempt |
| Port `3000` | Default **`4001`** — avoids Vite on 3000 and POS on 4000 |
| `mysql2` + callbacks | Uses **`mysql2/promise`** + `async/await` |
| `.env` not loaded from backend folder | **`dotenv`** path points to `backend/.env` |
| Reset link to `localhost:3000/reset-password/${token}` | Link targets **this server** so `GET /reset-password/:token` works |

### Env

Set in `backend/.env`:

- `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`
- `EMAIL_USER`, `EMAIL_PASS` (Gmail app password)
- Optional: `SMTP_FROM`, `STANDALONE_RESET_PORT`, `FRONTEND_URL` (defaults to `http://localhost:4001` for the link base)

### Run

```bash
cd backend
node examples/standalone-forgot-password-server.cjs
```

### Main POS app

The real app uses **TypeScript** on port **4000**, React on **3000**, reset links with **`?token=`** and hashed tokens in `password_resets` when using the integrated flow. Use this file only if you want the **exact tutorial-style** path `/reset-password/:token` on one small server.

### Security note

This example stores the **raw** token in MySQL (like many tutorials). The integrated POS backend hashes tokens before storage. Raw tokens are OK for learning; prefer hashing in production.
