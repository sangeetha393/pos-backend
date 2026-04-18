import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

function dbHost(): string | undefined {
  return (process.env.DB_HOST || process.env.MYSQL_HOST)?.trim();
}

/** Returns a pool if DB_HOST or MYSQL_HOST is set; otherwise null (app uses JSON files). */
export function getMysqlPool(): mysql.Pool | null {
  if (pool) return pool;
  const host = dbHost();
  if (!host) return null;
  pool = mysql.createPool({
    host,
    port: Number(process.env.DB_PORT || process.env.MYSQL_PORT) || 3306,
    user: process.env.DB_USER || process.env.MYSQL_USER || "root",
    password: process.env.DB_PASS ?? process.env.MYSQL_PASSWORD ?? "",
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE || "pos",
    waitForConnections: true,
    connectionLimit: 10
  });
  return pool;
}

export function isMysqlEnabled(): boolean {
  return !!dbHost();
}
