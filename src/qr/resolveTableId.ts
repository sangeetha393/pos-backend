/** Resolve QR `table` param (e.g. "3", "T3", "Table 3") to canonical floor table id. */
export function resolveTableIdFromQrParam(
  raw: string,
  tables: { id: string; name: string }[]
): string | null {
  const t = raw.trim();
  if (!t) return null;
  const exact = tables.find((x) => x.id === t);
  if (exact) return exact.id;

  const digits = t.replace(/\D/g, "");
  if (!digits) return null;

  const byIdNum = tables.find((x) => {
    const idNum = x.id.replace(/\D/g, "");
    return idNum === digits;
  });
  if (byIdNum) return byIdNum.id;

  const byNameNum = tables.find((x) => {
    const nn = x.name.replace(/\D/g, "");
    return nn === digits;
  });
  return byNameNum?.id ?? null;
}
