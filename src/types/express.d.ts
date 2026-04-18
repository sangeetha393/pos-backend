declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: "admin" | "staff" | "manager" | "chief" | "kitchen" | "super_admin";
        storeId: string;
      };
    }
  }
}

export {};
