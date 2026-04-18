# Forgot password OTP API (`/api`)

**Easiest overview (flows + checklist):** see **`FORGOT_PASSWORD_FLOW.md`**.

## Gmail — how to get mail to send

1. Use a **Gmail** account with **2-Step Verification** turned on:  
   https://myaccount.google.com/security
2. Create an **App password**:  
   https://myaccount.google.com/apppasswords  
   (Google shows 16 characters, e.g. `abcd efgh ijkl mnop` — paste **without spaces** in `.env`.)
3. In `backend/.env` set:
   ```env
   SMTP_USER=your@gmail.com
   SMTP_PASS=abcdefghijklmnop
   SMTP_FROM=your@gmail.com
   ```
4. **Restart** the backend after changing `.env`.
5. The email in **POST /api/send-otp** must exist in `data/users.json` (same as POS accounts).

## Trigger the flow (PowerShell)

Replace `PORT` if needed (default `4000`).

```powershell
$base = "http://localhost:4000/api"
$email = "admin@pos.com"

# 1) Send OTP (check inbox + spam)
Invoke-RestMethod -Method Post -Uri "$base/send-otp" -ContentType "application/json" -Body (@{ email = $email } | ConvertTo-Json)

# 2) Verify (use the 6-digit code from email)
$otp = "123456"
Invoke-RestMethod -Method Post -Uri "$base/verify-otp" -ContentType "application/json" -Body (@{ email = $email; otp = $otp } | ConvertTo-Json)

# 3) Reset password (only works after successful verify, within ~10 minutes)
Invoke-RestMethod -Method Post -Uri "$base/reset-password" -ContentType "application/json" -Body (@{ email = $email; newPassword = "NewSecure1" } | ConvertTo-Json)
```

## Endpoints

| Method | Path | Body | Notes |
|--------|------|------|--------|
| POST | `/api/send-otp` | `{ "email": "..." }` | 6-digit OTP, 10 min TTL, in memory |
| POST | `/api/verify-otp` | `{ "email": "...", "otp": "..." }` | `valid: true/false` in JSON |
| POST | `/api/reset-password` | `{ "email": "...", "newPassword": "..." }` | Only after verify; bcrypt; clears OTP |

## cURL (optional)

```bash
curl -s -X POST http://localhost:4000/api/send-otp -H "Content-Type: application/json" -d "{\"email\":\"admin@pos.com\"}"
```
