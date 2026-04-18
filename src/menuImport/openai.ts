import type { AiRecipeBlock, OpenAiChatMessage, ParsedMenuItem } from "./types";
import { dedupeMenuItems } from "./units";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

function getKey(): string | undefined {
  const k = process.env.OPENAI_API_KEY?.trim();
  return k || undefined;
}

export function hasOpenAiKey(): boolean {
  return !!getKey();
}

async function chatJson<T>(
  messages: OpenAiChatMessage[],
  model: string,
  jsonObject: boolean
): Promise<T> {
  const key = getKey();
  if (!key) throw new Error("OPENAI_API_KEY is not set in backend environment.");

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      ...(jsonObject ? { response_format: { type: "json_object" } } : {})
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content.");
  return JSON.parse(content) as T;
}

const MENU_PARSE_SYSTEM = `You are a restaurant menu data extractor.
Extract all food and drink items from the menu text.
Rules:
- Remove duplicates (same item listed twice → one entry).
- Normalize names (Title Case, fix typos where obvious).
- Infer category: Pizza, Burger, Pasta, Sandwich, Beverage, Dessert, Coffee, Fried Chicken, etc.
- If price appears next to item, include as number (strip currency symbols).
- Infer type: "veg", "non_veg", or "egg" from item name (chicken/mutton/fish/egg → appropriate).
Return strict JSON: { "items": [ { "name": string, "category": string, "price"?: number, "type"?: "veg"|"non_veg"|"egg" } ] }`;

const RECIPE_SYSTEM = `You are a restaurant kitchen recipe estimator.
For each menu item, propose practical ingredient usage for ONE portion/order.
Use realistic restaurant-scale quantities.
Units: prefer g, ml, kg, litre, or pcs. Keep ingredient names short and generic (e.g. "Mozzarella cheese" not poetry).
Return strict JSON:
{ "recipes": [ {
  "productName": string (must match input name exactly),
  "confidence": number 0-100 (how sure you are),
  "needsReview": true (always true for AI-generated),
  "ingredients": [ { "name": string, "qty": number, "unit": string } ]
} ] }`;

export async function transcribeMenuImageBase64(base64: string, mime: string): Promise<string> {
  const key = getKey();
  if (!key) throw new Error("OPENAI_API_KEY required for image menu import.");

  const messages: OpenAiChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Extract every dish and drink from this menu image as plain text, preserving structure (sections and item names). Include prices if visible. Output only the transcript, no JSON.`
        },
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }
  ];

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.1
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI vision error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content || "").trim();
}

export async function aiParseMenuItems(menuText: string): Promise<ParsedMenuItem[]> {
  const trimmed = menuText.trim();
  if (!trimmed) return [];

  const out = await chatJson<{ items?: ParsedMenuItem[] }>(
    [
      { role: "system", content: MENU_PARSE_SYSTEM },
      { role: "user", content: `Menu text:\n\n${trimmed.slice(0, 120_000)}` }
    ],
    "gpt-4o-mini",
    true
  );

  const raw = Array.isArray(out.items) ? out.items : [];
  const cleaned: ParsedMenuItem[] = raw
    .filter((x) => x && typeof x.name === "string" && x.name.trim())
    .map((x) => ({
      name: String(x.name).trim(),
      category: String(x.category || "General").trim() || "General",
      price: typeof x.price === "number" && x.price >= 0 ? x.price : undefined,
      type: x.type === "veg" || x.type === "non_veg" || x.type === "egg" ? x.type : undefined
    }));

  return dedupeMenuItems(cleaned);
}

export async function aiGenerateRecipes(
  items: { name: string; category: string }[]
): Promise<AiRecipeBlock[]> {
  if (!items.length) return [];

  const payload = items.map((i) => ({ name: i.name, category: i.category }));
  const out = await chatJson<{ recipes?: AiRecipeBlock[] }>(
    [
      { role: "system", content: RECIPE_SYSTEM },
      {
        role: "user",
        content: `Generate recipes for these products (JSON array context):\n${JSON.stringify(payload).slice(0, 100_000)}`
      }
    ],
    "gpt-4o-mini",
    true
  );

  const raw = Array.isArray(out.recipes) ? out.recipes : [];
  return raw
    .filter((r) => r && typeof r.productName === "string" && Array.isArray(r.ingredients))
    .map((r) => ({
      productName: String(r.productName).trim(),
      confidence:
        typeof r.confidence === "number"
          ? Math.max(0, Math.min(100, Math.round(r.confidence)))
          : 70,
      needsReview: r.needsReview !== false,
      ingredients: (r.ingredients || [])
        .filter((i) => i && typeof i.name === "string")
        .map((i) => ({
          name: String(i.name).trim(),
          qty: Math.max(0, Number(i.qty) || 0),
          unit: String(i.unit || "pcs")
        }))
    }));
}
