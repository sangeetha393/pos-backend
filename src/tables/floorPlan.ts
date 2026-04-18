import { randomBytes } from "crypto";

export type FloorSection = { id: string; name: string };
export type FloorTable = { id: string; name: string; sectionId: string };
export type FloorPlan = { sections: FloorSection[]; tables: FloorTable[] };

/** Stable default id for empty / new stores (single section, no tables until added). */
export const DEFAULT_MAIN_SECTION_ID = "sec_main";

/** Display name for the default section on new stores. */
export const DEFAULT_MAIN_SECTION_NAME = "Main Area";
export const DEFAULT_STARTER_TABLE_COUNT = 10;

export function seedDefaultFloorPlan(): FloorPlan {
  return {
    sections: [{ id: DEFAULT_MAIN_SECTION_ID, name: DEFAULT_MAIN_SECTION_NAME }],
    tables: []
  };
}

export function seedStarterTables(sectionId: string, count = DEFAULT_STARTER_TABLE_COUNT): FloorTable[] {
  const safeCount = Number.isFinite(count) ? Math.max(1, Math.min(100, Math.floor(count))) : DEFAULT_STARTER_TABLE_COUNT;
  return Array.from({ length: safeCount }, (_, i) => {
    const n = i + 1;
    return { id: `T${n}`, name: `Table ${n}`, sectionId };
  });
}

export function newSectionId(): string {
  return `sec_${randomBytes(4).toString("hex")}`;
}

/** Rename legacy default section label for stores created before "Main Area". */
function finalizePlan(plan: FloorPlan): FloorPlan {
  for (const s of plan.sections) {
    if (s.id === DEFAULT_MAIN_SECTION_ID && s.name === "Main Hall") {
      s.name = DEFAULT_MAIN_SECTION_NAME;
    }
  }
  return plan;
}

function slugSectionId(name: string, used: Set<string>): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "area";
  let id = `sec_${base}`;
  let n = 0;
  while (used.has(id)) {
    n += 1;
    id = `sec_${base}_${n}`;
  }
  used.add(id);
  return id;
}

function coerceFloorTableRow(row: unknown): FloorTable | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const sectionId = typeof o.sectionId === "string" ? o.sectionId.trim() : "";
  if (!id || !name || !sectionId) return null;
  return { id, name, sectionId };
}

/**
 * One-pass normalization:
 * - Legacy: array of `{ id, name, section?: string }` → sections inferred by name
 * - Legacy: object missing sectionId on tables → repair using sections or default area
 */
export function normalizeFloorPlanDoc(raw: unknown): FloorPlan {
  if (Array.isArray(raw)) {
    return migrateLegacyTableArrayOnly(raw);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const secRaw = o.sections;
    const tabRaw = o.tables;
    if (Array.isArray(tabRaw) && !Array.isArray(secRaw)) {
      return migrateLegacyTableArrayOnly(tabRaw);
    }
    if (Array.isArray(secRaw) && Array.isArray(tabRaw)) {
      return repairDocument(secRaw, tabRaw);
    }
  }
  return seedDefaultFloorPlan();
}

function migrateLegacyTableArrayOnly(rows: unknown[]): FloorPlan {
  if (!rows.length) return seedDefaultFloorPlan();

  const nameToId = new Map<string, string>();
  const used = new Set<string>();
  const sections: FloorSection[] = [];

  function ensureBySectionName(secName: string): string {
    const label = secName.trim() || DEFAULT_MAIN_SECTION_NAME;
    const hit = nameToId.get(label);
    if (hit) return hit;
    const id = slugSectionId(label, used);
    sections.push({ id, name: label });
    nameToId.set(label, id);
    return id;
  }

  const tables: FloorTable[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!id || !name) continue;

    let sectionId = typeof r.sectionId === "string" ? r.sectionId.trim() : "";
    if (sectionId) {
      if (!sections.some((s) => s.id === sectionId)) {
        const label = typeof r.section === "string" && r.section.trim() ? r.section.trim() : "Area";
        sections.push({ id: sectionId, name: label });
        used.add(sectionId);
      }
    } else {
      const secLabel = typeof r.section === "string" ? r.section.trim() : DEFAULT_MAIN_SECTION_NAME;
      sectionId = ensureBySectionName(secLabel);
    }
    tables.push({ id, name, sectionId });
  }

  if (!sections.length) return seedDefaultFloorPlan();
  return finalizePlan({ sections, tables });
}

function repairDocument(secRaw: unknown[], tabRaw: unknown[]): FloorPlan {
  const sections: FloorSection[] = [];
  const used = new Set<string>();
  for (const s of secRaw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!id || !name || used.has(id)) continue;
    used.add(id);
    sections.push({ id, name });
  }

  const labelToId = new Map<string, string>();
  for (const s of sections) labelToId.set(s.name, s.id);

  const tables: FloorTable[] = [];
  for (const row of tabRaw) {
    const t = coerceFloorTableRow(row);
    if (t) {
      tables.push(t);
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const legacySection = typeof r.section === "string" ? r.section.trim() : "";
    if (!id || !name) continue;
    let sectionId = typeof r.sectionId === "string" ? r.sectionId.trim() : "";
    if (!sectionId) {
      const label = legacySection || DEFAULT_MAIN_SECTION_NAME;
      const existing = labelToId.get(label);
      if (existing) sectionId = existing;
      else {
        sectionId = slugSectionId(label, used);
        sections.push({ id: sectionId, name: label });
        labelToId.set(label, sectionId);
      }
    }
    tables.push({ id, name, sectionId });
  }

  if (!sections.length) return seedDefaultFloorPlan();
  const fallback = sections[0].id;
  for (const t of tables) {
    if (!sections.some((s) => s.id === t.sectionId)) t.sectionId = fallback;
  }
  return finalizePlan({ sections, tables });
}

export function isAlreadyNormalized(raw: unknown, plan: FloorPlan): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as Partial<FloorPlan>;
  if (!Array.isArray(o.sections) || !Array.isArray(o.tables)) return false;
  try {
    return JSON.stringify({ sections: o.sections, tables: o.tables }) === JSON.stringify(plan);
  } catch {
    return false;
  }
}

export function sectionNameById(plan: FloorPlan, sectionId: string): string {
  const s = plan.sections.find((x) => x.id === sectionId);
  return s?.name ?? "—";
}
