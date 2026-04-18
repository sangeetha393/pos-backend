import { Request, Response } from "express";
import { sendForgotPasswordOtp, isSmtpConfigured } from "../config/mailer";
import * as otpStore from "../store/memoryOtpStore";
import * as userPassword from "../services/userPasswordFile";

function genSixDigitOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** POST /api/send-otp */
export async function postSendOtp(req: Request, res: Response): Promise<void> {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email) {
      res.status(400).json({ success: false, error: "Email is required" });
      return;
    }
    if (!isSmtpConfigured()) {
      res.status(500).json({
        success: false,
        error: "Email not configured. Set EMAIL_USER and EMAIL_PASS (or SMTP_USER/SMTP_PASS) in backend/.env"
      });
      return;
    }
    if (!userPassword.userExistsByEmail(email)) {
      res.status(404).json({ success: false, error: "No account found for this email" });
      return;
    }
    const otp = genSixDigitOtp();
    otpStore.saveOtp(email, otp);
    try {
      await sendForgotPasswordOtp(email, otp);
    } catch (err) {
      otpStore.deleteOtp(email);
      console.error("send-otp mail error:", err);
      res.status(500).json({
        success: false,
        error:
          "Failed to send email. Use a Gmail App Password (16 chars) in EMAIL_PASS, 2FA on, no spaces in .env."
      });
      return;
    }
    res.status(200).json({
      success: true,
      message: "OTP sent to your email. Valid for 10 minutes."
    });
  } catch (e) {
    console.error("postSendOtp:", e);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
}

/** POST /api/verify-otp */
export function postVerifyOtp(req: Request, res: Response): void {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const otp = req.body?.otp != null ? String(req.body.otp) : "";
    if (!email || !otp) {
      res.status(400).json({ success: false, valid: false, error: "Email and OTP are required" });
      return;
    }
    const result = otpStore.verifyOtp(email, otp);
    if (!result.ok) {
      const msg =
        result.reason === "expired"
          ? "OTP expired. Request a new one."
          : result.reason === "not_found"
            ? "No OTP for this email. Call send-otp first."
            : result.reason === "wrong_phase"
              ? "Invalid state. Request a new OTP."
              : "Invalid OTP";
      res.status(400).json({ success: false, valid: false, error: msg });
      return;
    }
    res.status(200).json({
      success: true,
      valid: true,
      message: "OTP verified. You may reset your password within 10 minutes."
    });
  } catch (e) {
    console.error("postVerifyOtp:", e);
    res.status(500).json({ success: false, valid: false, error: "Internal server error" });
  }
}

/** POST /api/reset-password */
export async function postResetPassword(req: Request, res: Response): Promise<void> {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (!email || !newPassword) {
      res.status(400).json({ success: false, error: "Email and newPassword are required" });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
      return;
    }
    const gate = otpStore.assertCanResetPassword(email);
    if (!gate.ok) {
      const msg =
        gate.reason === "expired"
          ? "Verification expired. Verify OTP again."
          : "Verify OTP before resetting password.";
      res.status(403).json({ success: false, error: msg });
      return;
    }
    const updated = await userPassword.updateUserPasswordByEmail(email, newPassword);
    if (!updated) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }
    otpStore.deleteOtp(email);
    res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (e) {
    console.error("postResetPassword:", e);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
}
