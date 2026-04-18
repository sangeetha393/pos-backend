import nodemailer from "nodemailer";
import { Resend } from "resend";
import { getSmtpUser, getSmtpPass, hasSmtpCredentials, getSmtpFrom } from "./config/emailEnv";

// Resend (easiest: just add RESEND_API_KEY - free 100 emails/day)
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

function smtpTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: getSmtpUser(),
      pass: getSmtpPass()
    }
  });
}

export function isEmailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY || hasSmtpCredentials());
}

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  const subject = "Password Reset OTP - POS Platform";
  const text = `Your OTP for password reset is: ${otp}\n\nValid for 10 minutes.\n\nIf you didn't request this, ignore this email.`;
  const html = `
    <p>Your OTP for password reset is: <strong>${otp}</strong></p>
    <p>Valid for 10 minutes.</p>
    <p>If you didn't request this, please ignore this email.</p>
  `;

  // Option 1: Resend (simple - just API key)
  if (resend) {
    const from = process.env.RESEND_FROM || "POS Platform <onboarding@resend.dev>";
    const { data, error } = await resend.emails.send({
      from,
      to: [to],
      subject,
      html
    });
    if (error) throw new Error(error.message);
    return;
  }

  // Option 2: SMTP (Gmail, etc.) — EMAIL_USER/EMAIL_PASS or SMTP_USER/SMTP_PASS
  if (hasSmtpCredentials()) {
    const from = getSmtpFrom() || getSmtpUser();
    await smtpTransport().sendMail({
      from: `"POS Platform" <${from}>`,
      to,
      subject,
      text,
      html
    });
    return;
  }

  throw new Error("No email configured. Add RESEND_API_KEY or EMAIL_USER/EMAIL_PASS (or SMTP_*) to .env");
}

export async function sendPasswordResetLinkEmail(to: string, resetUrl: string): Promise<void> {
  const subject = "Reset your password - POS Platform";
  const text = `Reset your password by opening this link (valid 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, ignore this email.`;
  const html = `
    <p>Click the link below to choose a new password. This link expires in <strong>1 hour</strong>.</p>
    <p><a href="${resetUrl}">Reset password</a></p>
    <p>If the button doesn't work, copy this URL into your browser:</p>
    <p style="word-break:break-all">${resetUrl}</p>
    <p>If you didn't request this, you can ignore this email.</p>
  `;

  if (resend) {
    const from = process.env.RESEND_FROM || "POS Platform <onboarding@resend.dev>";
    const { error } = await resend.emails.send({
      from,
      to: [to],
      subject,
      html
    });
    if (error) throw new Error(error.message);
    return;
  }

  if (hasSmtpCredentials()) {
    const from = getSmtpFrom() || getSmtpUser();
    await smtpTransport().sendMail({
      from: `"POS Platform" <${from}>`,
      to,
      subject,
      text,
      html
    });
    return;
  }

  throw new Error("No email configured. Add RESEND_API_KEY or EMAIL_USER/EMAIL_PASS (or SMTP_*) to .env");
}

export async function sendPasswordChangedEmail(to: string): Promise<void> {
  const subject = "Password updated successfully - POS Platform";
  const text = "Your password has been updated successfully. If you didn't make this change, please contact support.";
  const html = `
    <p>Your password has been updated successfully.</p>
    <p>If you didn't make this change, please contact support.</p>
  `;
  if (resend) {
    const from = process.env.RESEND_FROM || "POS Platform <onboarding@resend.dev>";
    const { error } = await resend.emails.send({ from, to: [to], subject, html });
    if (error) throw new Error(error.message);
    return;
  }
  if (hasSmtpCredentials()) {
    const from = getSmtpFrom() || getSmtpUser();
    await smtpTransport().sendMail({
      from: `"POS Platform" <${from}>`,
      to,
      subject,
      text,
      html
    });
    return;
  }
  // Optional: no throw if not configured; password was still updated
}
