/** Single definition so the same secret is used to sign and verify tokens. */
export function getJwtSecret(): string {
  const raw = process.env.JWT_SECRET;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.length > 0) return t;
  }
  return "pos-demo-secret";
}
