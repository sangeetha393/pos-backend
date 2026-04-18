import { Router } from "express";
import {
  postSendOtp,
  postVerifyOtp,
  postResetPassword
} from "../controllers/forgotOtpController";

const router = Router();

router.post("/send-otp", (req, res) => {
  void postSendOtp(req, res);
});

router.post("/verify-otp", (req, res) => {
  postVerifyOtp(req, res);
});

router.post("/reset-password", (req, res) => {
  void postResetPassword(req, res);
});

export default router;
