import { createClient, type Client } from "@libsql/client";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export type EnvironmentRecord = {
  id: string;
  name: string;
  slug: string;
  provider: string;
  status: "stopped" | "running" | "error";
  data: Record<string, any>;
  testInstance: boolean;
  createdAt: string;
  updatedAt: string;
};

export class EnvironmentStore {
  private constructor(private readonly db: Client) {}

  static async connect(url: string) {
    if (url.startsWith("file:")) await mkdir(dirname(resolve(url.slice(5))), { recursive: true });
    const store = new EnvironmentStore(createClient({ url }));
    await store.db.execute(`CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      data_json TEXT NOT NULL,
      test_instance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    return store;
  }

  async list(): Promise<EnvironmentRecord[]> {
    const result = await this.db.execute("SELECT * FROM environments ORDER BY updated_at DESC");
    return result.rows.map((row) => this.fromRow(row));
  }

  async get(id: string): Promise<EnvironmentRecord | undefined> {
    const result = await this.db.execute({ sql: "SELECT * FROM environments WHERE id = ?", args: [id] });
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async getBySlug(slug: string): Promise<EnvironmentRecord | undefined> {
    const result = await this.db.execute({ sql: "SELECT * FROM environments WHERE slug = ?", args: [slug] });
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async create(input: { name: string; slug: string; provider: string; data: Record<string, any>; testInstance?: boolean }): Promise<EnvironmentRecord> {
    const now = new Date().toISOString();
    const row: EnvironmentRecord = {
      id: randomUUID(), name: input.name, slug: input.slug, provider: input.provider, status: "stopped",
      data: input.data, testInstance: Boolean(input.testInstance), createdAt: now, updatedAt: now,
    };
    await this.db.execute({
      sql: `INSERT INTO environments (id,name,slug,provider,status,data_json,test_instance,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [row.id, row.name, row.slug, row.provider, row.status, JSON.stringify(row.data), row.testInstance ? 1 : 0, now, now],
    });
    return row;
  }

  async updateData(id: string, data: Record<string, any>): Promise<EnvironmentRecord | undefined> {
    await this.db.execute({ sql: "UPDATE environments SET data_json = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(data), new Date().toISOString(), id] });
    return this.get(id);
  }

  async updateStatus(id: string, status: EnvironmentRecord["status"]): Promise<void> {
    await this.db.execute({ sql: "UPDATE environments SET status = ?, updated_at = ? WHERE id = ?", args: [status, new Date().toISOString(), id] });
  }

  async delete(id: string): Promise<void> {
    await this.db.execute({ sql: "DELETE FROM environments WHERE id = ?", args: [id] });
  }

  async close() { this.db.close(); }

  private fromRow(row: Record<string, unknown>): EnvironmentRecord {
    return {
      id: String(row.id), name: String(row.name), slug: String(row.slug), provider: String(row.provider),
      status: String(row.status) as EnvironmentRecord["status"], data: JSON.parse(String(row.data_json)),
      testInstance: Number(row.test_instance) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
