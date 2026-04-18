export type ProductInventoryRow = { productId: string; qty: number; unit: string; lowStock: number };

export type AppSettingsShape = {
  currency: string;
  currencySymbol: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyLogoUrl: string;
  loyaltyPointsPer100: number;
  loyaltyRedeemPer100Points: number;
  chefAbsent: boolean;
};
