import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { EnvironmentRecord, EnvironmentStore } from "../store.js";

type RunningInstance = { child: ChildProcess; port: number; dataFile: string };

export class MockoonRuntime {
  private readonly instances = new Map<string, RunningInstance>();
  private readonly cliPath: string;
  private readonly dataRoot: string;

  constructor(private readonly store: EnvironmentStore, private readonly config: AppConfig) {
    const require = createRequire(import.meta.url);
    this.cliPath = resolve(dirname(require.resolve("@mockoon/cli/package.json")), "bin/run.js");
    this.dataRoot = join(config.dataDir, "runtime");
  }

  async restore() {
    await mkdir(this.dataRoot, { recursive: true });
    for (const environment of await this.store.list()) {
      if (environment.status !== "running") continue;
      try { await this.deploy(environment); }
      catch { await this.store.updateStatus(environment.id, "error"); }
    }
  }

  async deploy(environment: EnvironmentRecord) {
    await mkdir(this.dataRoot, { recursive: true });
    const revision = randomUUID();
    const dataFile = join(this.dataRoot, `${environment.id}-${revision}.json`);
    const publicUrl = this.publicUrl(environment.slug);
    const data = { ...environment.data, hostname: "127.0.0.1", port: 0 };
    await writeFile(dataFile, JSON.stringify(data));
    const port = await this.reservePort();
    const child = spawn(process.execPath, [this.cliPath, "start", "--data", dataFile,
      "--port", String(port), "--hostname", "127.0.0.1", "--disable-admin-api",
      "--disable-log-to-file", "--public-base-url", publicUrl], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOCKOON_ADMIN_API_TOKEN: "" },
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4000); });
    child.stderr?.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-4000); });
    const candidate = { child, port, dataFile };
    try {
      await this.waitForPort(child, port, () => output);
    } catch (error) {
      await this.stopChild(candidate);
      await rm(dataFile, { force: true });
      throw error;
    }
    const previous = this.instances.get(environment.id);
    this.instances.set(environment.id, candidate);
    await this.store.updateStatus(environment.id, "running");
    if (previous) await this.stopChild(previous);
    return this.details((await this.store.get(environment.id)) ?? { ...environment, status: "running" }, port);
  }

  async stop(id: string) {
    const instance = this.instances.get(id);
    if (instance) {
      this.instances.delete(id);
      await this.stopChild(instance);
    }
    await this.store.updateStatus(id, "stopped");
  }

  async remove(id: string) {
    await this.stop(id);
    await this.store.delete(id);
  }

  async resolveSlug(slug: string) {
    const environment = await this.store.getBySlug(slug);
    if (!environment || environment.status !== "running") return undefined;
    const instance = this.instances.get(environment.id);
    return instance ? { environment, port: instance.port } : undefined;
  }

  async details(environment: EnvironmentRecord, port?: number) {
    const current = port ?? this.instances.get(environment.id)?.port;
    return { ...environment, url: this.publicUrl(environment.slug), internalPort: current };
  }

  publicUrl(slug: string) {
    const scheme = this.config.nodeEnv === "production" ? "https" : "http";
    const port = this.config.nodeEnv === "production" ? "" : `:${this.config.port}`;
    return `${scheme}://${slug}.${this.config.baseDomain}${port}`;
  }

  async shutdown() {
    await Promise.all([...this.instances.values()].map((instance) => this.stopChild(instance)));
    this.instances.clear();
  }

  private async reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
  }

  private async waitForPort(child: ChildProcess, port: number, readOutput: () => string) {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Mock runtime exited during startup. ${readOutput()}`.trim());
      try {
        await new Promise<void>((resolve, reject) => {
          const connection = createConnection({ host: "127.0.0.1", port });
          connection.once("connect", () => { connection.destroy(); resolve(); });
          connection.once("error", reject);
        });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`Mock runtime did not start within 15 seconds. ${readOutput()}`.trim());
  }

  private async stopChild(instance: RunningInstance) {
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { instance.child.kill("SIGKILL"); resolve(); }, 3000);
        instance.child.once("exit", () => { clearTimeout(timeout); resolve(); });
        instance.child.kill("SIGTERM");
      });
    }
    await rm(instance.dataFile, { force: true });
  }
}
