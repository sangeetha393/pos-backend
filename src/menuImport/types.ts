/** Menu item after AI parse (before product id exists). */
export type ParsedMenuItem = {
  name: string;
  category: string;
  price?: number;
  type?: "veg" | "non_veg" | "egg";
};

export type AiRecipeIngredient = {
  name: string;
  qty: number;
  unit: string;
};

/** One dish recipe from AI (matched by product name then id). */
export type AiRecipeBlock = {
  productName: string;
  confidence: number;
  needsReview: boolean;
  ingredients: AiRecipeIngredient[];
};

/** Persisted per-product AI recipe quality flags. */
export type RecipeProductMeta = {
  productId: string;
  confidence: number;
  needsReview: boolean;
  source: "ai_menu_import";
  updatedAt: string;
};

export type OpenAiChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "user";
      content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    };
