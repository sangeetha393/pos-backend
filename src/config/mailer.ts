import nodemailer from "nodemailer";
import { getSmtpUser, getSmtpPass, hasSmtpCredentials, getSmtpFrom } from "./emailEnv";

/**
 * Gmail SMTP (Nodemailer).
 * Set EMAIL_USER / EMAIL_PASS (or SMTP_USER / SMTP_PASS) — use a Google App Password.
 */
export function createMailerTransporter(): nodemailer.Transporter {
  const user = getSmtpUser();
  const pass = getSmtpPass();
  if (!user || !pass) {
    throw new Error("EMAIL_USER/EMAIL_PASS or SMTP_USER/SMTP_PASS must be set in environment");
  }
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user, pass }
  });
}

export function isSmtpConfigured(): boolean {
  return hasSmtpCredentials();
}

export async function sendForgotPasswordOtp(to: string, otp: string): Promise<void> {
  const transporter = createMailerTransporter();
  const from = getSmtpFrom() || getSmtpUser();
  const subject = "Password reset OTP";
  const text = `Your password reset OTP is: ${otp}\n\nIt expires in 10 minutes.\n\nIf you did not request this, ignore this email.`;
  const html = `
    <p>Your password reset OTP is: <strong>${otp}</strong></p>
    <p>It expires in 10 minutes.</p>
    <p>If you did not request this, ignore this email.</p>
  `;
  await transporter.sendMail({
    from: `"POS Platform" <${from}>`,
    to,
    subject,
    text,
    html
  });
}
