/**
 * SMTP credentials: prefer EMAIL_USER / EMAIL_PASS, fall back to SMTP_USER / SMTP_PASS.
 */
export function getSmtpUser(): string {
  return (process.env.EMAIL_USER || process.env.SMTP_USER || "").trim();
}

export function getSmtpPass(): string {
  return (process.env.EMAIL_PASS || process.env.SMTP_PASS || "").trim();
}

export function hasSmtpCredentials(): boolean {
  return !!(getSmtpUser() && getSmtpPass());
}

export function getSmtpFrom(): string {
  return (
    (process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.EMAIL_USER || process.env.SMTP_USER || "") as string
  ).trim();
}
