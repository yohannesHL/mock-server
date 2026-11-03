import { createClient, type Client } from "@libsql/client";
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export type EnvironmentRecord = {
  id: string;
  name: string;
  slug: string;
  provider: string;
  status: "stopped" | "running" | "error";
  data: Record<string, any>;
  projectId?: string | null;
  testInstance: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRecord = {
  id: string;
  name: string;
  slug: string;
  tokenHash: string;
  lastSeenAt: string | null;
  createdAt: string;
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
    const columns = await store.db.execute("PRAGMA table_info(environments)");
    if (!columns.rows.some((column) => column.name === "project_id"))
      await store.db.execute("ALTER TABLE environments ADD COLUMN project_id TEXT");
    await store.db.execute(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
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

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await this.db.execute("SELECT * FROM projects ORDER BY created_at DESC");
    return result.rows.map((row) => this.projectFromRow(row));
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const result = await this.db.execute({ sql: "SELECT * FROM projects WHERE id = ?", args: [id] });
    return result.rows[0] ? this.projectFromRow(result.rows[0]) : undefined;
  }

  async getProjectByToken(token: string): Promise<ProjectRecord | undefined> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const result = await this.db.execute({ sql: "SELECT * FROM projects WHERE token_hash = ?", args: [tokenHash] });
    return result.rows[0] ? this.projectFromRow(result.rows[0]) : undefined;
  }

  async createProject(input: { name: string; slug: string; token: string }): Promise<ProjectRecord> {
    const row: ProjectRecord = { id: randomUUID(), name: input.name, slug: input.slug,
      tokenHash: createHash("sha256").update(input.token).digest("hex"), lastSeenAt: null, createdAt: new Date().toISOString() };
    await this.db.execute({ sql: "INSERT INTO projects (id,name,slug,token_hash,last_seen_at,created_at) VALUES (?,?,?,?,?,?)",
      args: [row.id, row.name, row.slug, row.tokenHash, null, row.createdAt] });
    return row;
  }

  async rotateProjectToken(id: string, token: string): Promise<void> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await this.db.execute({ sql: "UPDATE projects SET token_hash = ?, last_seen_at = NULL WHERE id = ?", args: [tokenHash, id] });
  }

  async touchProject(id: string): Promise<void> {
    await this.db.execute({ sql: "UPDATE projects SET last_seen_at = ? WHERE id = ?", args: [new Date().toISOString(), id] });
  }

  async stopProject(id: string): Promise<void> {
    await this.db.execute({ sql: "UPDATE projects SET last_seen_at = NULL WHERE id = ?", args: [id] });
  }

  async isProjectActive(id: string, maxAgeMs = 30_000): Promise<boolean> {
    const project = await this.getProject(id);
    return Boolean(project?.lastSeenAt && Date.now() - Date.parse(project.lastSeenAt) <= maxAgeMs);
  }

  async listProjectEnvironments(projectId: string): Promise<EnvironmentRecord[]> {
    const result = await this.db.execute({ sql: "SELECT * FROM environments WHERE project_id = ? ORDER BY name", args: [projectId] });
    return result.rows.map((row) => this.fromRow(row));
  }

  async create(input: { name: string; slug: string; provider: string; data: Record<string, any>; projectId?: string; testInstance?: boolean }): Promise<EnvironmentRecord> {
    const now = new Date().toISOString();
    const row: EnvironmentRecord = {
      id: randomUUID(), name: input.name, slug: input.slug, provider: input.provider, status: "stopped",
      data: input.data, projectId: input.projectId ?? null, testInstance: Boolean(input.testInstance), createdAt: now, updatedAt: now,
    };
    await this.db.execute({
      sql: `INSERT INTO environments (id,name,slug,provider,status,data_json,test_instance,created_at,updated_at,project_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [row.id, row.name, row.slug, row.provider, row.status, JSON.stringify(row.data), row.testInstance ? 1 : 0, now, now, row.projectId ?? null],
    });
    return row;
  }

  async updateData(id: string, data: Record<string, any>): Promise<EnvironmentRecord | undefined> {
    await this.db.execute({ sql: "UPDATE environments SET data_json = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(data), new Date().toISOString(), id] });
    return this.get(id);
  }

  async updateProjectEnvironment(id: string, input: { name: string; provider: string; data: Record<string, any> }): Promise<EnvironmentRecord | undefined> {
    await this.db.execute({ sql: "UPDATE environments SET name = ?, provider = ?, data_json = ?, updated_at = ? WHERE id = ?",
      args: [input.name, input.provider, JSON.stringify(input.data), new Date().toISOString(), id] });
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
      status: String(row.status) as EnvironmentRecord["status"], data: JSON.parse(String(row.data_json)), projectId: row.project_id ? String(row.project_id) : null,
      testInstance: Number(row.test_instance) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private projectFromRow(row: Record<string, unknown>): ProjectRecord {
    return { id: String(row.id), name: String(row.name), slug: String(row.slug), tokenHash: String(row.token_hash),
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null, createdAt: String(row.created_at) };
  }
}
