import { MongoClient, type Db, type Collection, ObjectId } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;

export function isMongoQrConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI?.trim());
}

export async function initMongoQr(): Promise<void> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    console.warn("[mongo] MONGODB_URI not set — QR orders use in-memory/JSON only.");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    const dbName = process.env.MONGODB_DB?.trim() || "restaurant_pos";
    db = client.db(dbName);
    await db.collection("qr_orders").createIndex({ posOrderId: 1 }, { unique: true });
    await db.collection("qr_orders").createIndex({ storeId: 1, createdAt: -1 });
    await db.collection("qr_customers").createIndex({ phone: 1 }, { unique: true });
    console.log(`[mongo] Connected → db "${dbName}"`);
  } catch (e) {
    console.error("[mongo] connection failed:", e);
    client = null;
    db = null;
  }
}

export async function closeMongoQr(): Promise<void> {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  client = null;
  db = null;
}

export function isMongoQrLive(): boolean {
  return db !== null;
}

export type QrOrderDoc = {
  _id?: ObjectId;
  posOrderId: string;
  storeId: string;
  table: string;
  tableId: string;
  customerName: string;
  phone: string;
  items: unknown[];
  total: number;
  status: string;
  createdAt: Date;
};

export type QrCustomerDoc = {
  _id?: ObjectId;
  name: string;
  phone: string;
  visitCount: number;
  lastVisitAt: Date;
};

function ordersCol(): Collection<QrOrderDoc> {
  if (!db) throw new Error("MongoDB not connected");
  return db.collection<QrOrderDoc>("qr_orders");
}

function customersCol(): Collection<QrCustomerDoc> {
  if (!db) throw new Error("MongoDB not connected");
  return db.collection<QrCustomerDoc>("qr_customers");
}

export async function insertQrOrder(doc: Omit<QrOrderDoc, "_id">): Promise<void> {
  if (!isMongoQrLive()) return;
  await ordersCol().insertOne({ ...doc, createdAt: doc.createdAt ?? new Date() });
}

export async function updateQrOrderStatus(
  posOrderId: string,
  status: string
): Promise<void> {
  if (!isMongoQrLive()) return;
  await ordersCol().updateOne({ posOrderId }, { $set: { status } } );
}

export async function upsertQrCustomer(name: string, phone: string): Promise<void> {
  if (!isMongoQrLive()) return;
  const norm = phone.replace(/\D/g, "");
  if (norm.length < 7) return;
  await customersCol().updateOne(
    { phone: norm },
    {
      $set: { name: name.trim(), lastVisitAt: new Date() },
      $inc: { visitCount: 1 },
      $setOnInsert: { phone: norm }
    },
    { upsert: true }
  );
}
