import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import httpProxy from "http-proxy";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { MockoonRuntime } from "./runtime/manager.js";
import { EnvironmentStore, type EnvironmentRecord } from "./store.js";

const execFile = promisify(execFileCallback);
const config = loadConfig();
const root = process.cwd();
const providerDirectory = resolve(root, "providers");
const cookieName = "mock_server_session";
const sessionLifetimeSeconds = 12 * 60 * 60;
const mockUrlSchema = z.object({
  name: z.string().trim().min(2).max(64),
  templateId: z.string().regex(/^[a-z0-9-]+$/),
});
const testInstanceSchema = z.object({
  name: z.string().trim().min(2).max(64).optional(),
  templateId: z.string().regex(/^[a-z0-9-]+$/).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,50}$/).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => value.templateId || value.data, "A templateId or environment document is required.");
const addRouteSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]),
  path: z.string().trim().min(1).max(180),
  statusCode: z.number().int().min(100).max(599).default(200),
  body: z.string().max(100_000).default("{}"),
  headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/),
    z.string().max(8_000).refine((value) => !/[\r\n]/.test(value), "Header values cannot contain line breaks.")).refine((value) => Object.keys(value).length <= 32).optional(),
  latency: z.number().int().min(0).max(10_000).default(0),
});

type Template = { id: string; name: string; provider: string; description: string; data: Record<string, any> };

const providerNames: Record<string, { name: string; provider: string; description: string }> = {
  "openai": { name: "OpenAI", provider: "OpenAI", description: "Responses API mock with bearer-key auth." },
  "anthropic": { name: "Anthropic", provider: "Anthropic", description: "Messages API mock with API-key auth." },
  "google-ads": { name: "Google Ads", provider: "Google Ads", description: "OAuth, account discovery, and campaign API fixtures." },
  "meta-ads": { name: "Meta Ads", provider: "Meta", description: "Business OAuth and Ads Graph API fixtures." },
  "meta-publishing": { name: "Meta Publishing", provider: "Meta", description: "OAuth, media upload, and publishing API fixtures." },
  "youtube": { name: "YouTube", provider: "YouTube", description: "Google OAuth, channel discovery, uploads, and video status." },
  "tiktok": { name: "TikTok", provider: "TikTok", description: "Login Kit, creator info, and direct-publishing API fixtures." },
  "linkedin": { name: "LinkedIn", provider: "LinkedIn", description: "OAuth, organization access, media upload, and post APIs." },
  "x": { name: "X", provider: "X", description: "OAuth 2.0, media upload, and post API fixtures." },
};

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "mock-api";
}

function sign(payload: string) {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({ email: config.adminEmail, exp: Math.floor(Date.now() / 1000) + sessionLifetimeSeconds })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function validSession(token?: string) {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.email === config.adminEmail && Number(session.exp) > Date.now() / 1000;
  } catch { return false; }
}

function hasSession(request: FastifyRequest) {
  return validSession(request.cookies?.[cookieName]);
}

function makeSlug(name: string, existing: EnvironmentRecord[]) {
  const base = slugify(name);
  const used = new Set(existing.map((environment) => environment.slug));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index++) if (!used.has(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-${randomUUID().slice(0, 8)}`;
}

function regenerateUuids(value: any) {
  const replacements = new Map<string, string>();
  const collect = (item: any) => {
    if (!item || typeof item !== "object") return;
    if (typeof item.uuid === "string") replacements.set(item.uuid, randomUUID());
    for (const child of Object.values(item)) collect(child);
  };
  collect(value);
  const replace = (item: any): any => {
    if (Array.isArray(item)) return item.map(replace);
    if (!item || typeof item !== "object") return typeof item === "string" ? replacements.get(item) ?? item : item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, replace(child)]));
  };
  return replace(value);
}

async function loadTemplates(): Promise<Map<string, Template>> {
  const output = new Map<string, Template>();
  const files: string[] = [];
  for (const entry of await readdir(providerDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(join(providerDirectory, entry.name));
    if (entry.isDirectory()) for (const child of await readdir(join(providerDirectory, entry.name)))
      if (child.endsWith(".json")) files.push(join(providerDirectory, entry.name, child));
  }
  for (const filePath of files) {
    const file = basename(filePath);
    const id = basename(filePath, ".json");
    const metadata = providerNames[id] ?? { name: id, provider: id, description: "Imported Mock Server environment." };
    try {
      const data = JSON.parse(await readFile(filePath, "utf8"));
      output.set(id, { id, ...metadata, data });
    } catch (error) {
      console.warn(`Skipping invalid provider environment ${file}:`, error);
    }
  }
  return output;
}

async function validateEnvironment(data: Record<string, any>, dataDir: string) {
  const localRequire = createRequire(import.meta.url);
  const cliPath = resolve(dirname(localRequire.resolve("@mockoon/cli/package.json")), "bin/run.js");
  const tempPath = join(dataDir, "runtime", `validate-${randomUUID()}.json`);
  await mkdir(join(dataDir, "runtime"), { recursive: true });
  await writeFile(tempPath, JSON.stringify(data));
  try {
    await execFile(process.execPath, [cliPath, "validate", "--data", tempPath], { timeout: 12_000 });
  } finally {
    await rm(tempPath, { force: true });
  }
}

function basicRoute(environment: Record<string, any>, input: z.infer<typeof addRouteSchema>) {
  const templateResponse = environment.routes?.[0]?.responses?.[0] ?? {};
  const response = {
    ...structuredClone(templateResponse),
    uuid: randomUUID(), body: input.body, latency: input.latency, statusCode: input.statusCode,
    label: "Default response", headers: Object.entries(input.headers ?? { "Content-Type": "application/json" }).map(([key, value]) => ({ key, value })),
    bodyType: "INLINE", filePath: "", databucketID: "", rules: [], rulesOperator: "AND",
    disableTemplating: true, fallbackTo404: false, default: true, callbacks: [],
  };
  const route = {
    uuid: randomUUID(), type: "http", documentation: "", method: input.method.toLowerCase(),
    endpoint: input.path.replace(/^\/+/, "").replace(/\/+$/, ""), responses: [response],
    responseMode: null, streamingMode: null, streamingInterval: 0,
  };
  return route;
}

async function main() {
  const store = await EnvironmentStore.connect(config.databaseUrl);
  const runtime = new MockoonRuntime(store, config);
  const templates = await loadTemplates();
  const app = Fastify({ logger: { level: config.nodeEnv === "test" ? "warn" : "info" }, bodyLimit: 1_000_000 });
  const proxy = httpProxy.createProxyServer({ proxyTimeout: 60_000, timeout: 60_000 });
  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const hostname = (request.headers.host ?? "").split(":")[0].toLowerCase();
    const suffix = `.${config.baseDomain}`;
    if (!hostname.endsWith(suffix)) return;
    const slug = hostname.slice(0, -suffix.length);
    if (!/^[a-z0-9][a-z0-9-]{0,50}$/.test(slug)) return;
    const target = await runtime.resolveSlug(slug);
    if (!target) {
      reply.code(404).send({ error: "Mock environment is not deployed", slug });
      return;
    }
    reply.hijack();
    proxy.web(request.raw, reply.raw, {
      target: `http://127.0.0.1:${target.port}`,
      changeOrigin: true,
      xfwd: true,
    });
  });

  proxy.on("error", (_error, _request, response) => {
    const raw = response as import("node:http").ServerResponse;
    if (!raw.headersSent) raw.writeHead(502, { "content-type": "application/json" });
    raw.end(JSON.stringify({ error: "Mock environment is temporarily unavailable" }));
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"].includes(request.url.split("?")[0])) return;
    if (request.url.startsWith("/api/test/") && config.nodeEnv === "test" && config.testToken
      && request.headers["x-mock-server-test-token"] === config.testToken) return;
    if (!hasSession(request)) return reply.code(401).send({ error: "Sign in to manage mock environments." });
  });

  app.get("/api/health", async () => ({ ok: true, service: "mock-server" }));
  app.get("/api/auth/status", async (request) => ({ authenticated: hasSession(request), email: config.adminEmail }));
  app.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
    const email = request.body?.email?.trim().toLowerCase();
    const password = request.body?.password ?? "";
    const supplied = Buffer.from(password);
    const expected = Buffer.from(config.adminPassword);
    if (!email || email !== config.adminEmail.toLowerCase() || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return reply.code(401).send({ error: "Email or password is incorrect." });
    reply.setCookie(cookieName, createSession(), {
      path: "/", httpOnly: true, sameSite: "strict", secure: config.nodeEnv === "production",
      maxAge: sessionLifetimeSeconds,
    });
    return { authenticated: true, email: config.adminEmail };
  });
  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(cookieName, { path: "/" });
    return { authenticated: false };
  });

  app.get("/api/templates", async () => [...templates.values()].map(({ data, ...template }) => ({ ...template, routeCount: data.routes?.length ?? 0 })));
  app.get("/api/environments", async () => Promise.all((await store.list()).map((environment) => runtime.details(environment))));
  app.post<{ Body: unknown }>("/api/environments", async (request, reply) => {
    const parsed = mockUrlSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a name and choose a provider template." });
    const template = templates.get(parsed.data.templateId);
    if (!template) return reply.code(404).send({ error: "Provider template not found." });
    const data = regenerateUuids(structuredClone(template.data));
    data.name = parsed.data.name;
    data.hostname = "127.0.0.1";
    data.port = 0;
    const existing = await store.list();
    const environment = await store.create({
      name: parsed.data.name, slug: makeSlug(parsed.data.name, existing), provider: template.provider, data,
    });
    return reply.code(201).send(await runtime.details(environment));
  });

  app.get<{ Params: { id: string } }>("/api/environments/:id", async (request, reply) => {
    const environment = await store.get(request.params.id);
    if (!environment) return reply.code(404).send({ error: "Mock environment not found." });
    return runtime.details(environment);
  });

  app.put<{ Params: { id: string }; Body: { data?: Record<string, any> } }>("/api/environments/:id", async (request, reply) => {
    const current = await store.get(request.params.id);
    if (!current) return reply.code(404).send({ error: "Mock environment not found." });
    const next = request.body?.data;
    if (!next || typeof next !== "object" || Array.isArray(next)) return reply.code(400).send({ error: "A Mockoon environment document is required." });
    try { await validateEnvironment(next, config.dataDir); }
    catch (error) { return reply.code(422).send({ error: "Mockoon rejected this environment document.", detail: error instanceof Error ? error.message : "Validation failed" }); }
    const updated = { ...next, uuid: current.data.uuid, name: current.name, hostname: "127.0.0.1" };
    await store.updateData(current.id, updated);
    const saved = await store.get(current.id);
    if (current.status === "running" && saved) {
      try { await runtime.deploy(saved); }
      catch (error) {
        await store.updateData(current.id, current.data);
        await store.updateStatus(current.id, "running");
        return reply.code(422).send({ error: error instanceof Error ? error.message : "The new runtime did not become ready." });
      }
    }
    return runtime.details((await store.get(current.id))!);
  });

  app.post<{ Params: { id: string } }>("/api/environments/:id/deploy", async (request, reply) => {
    const environment = await store.get(request.params.id);
    if (!environment) return reply.code(404).send({ error: "Mock environment not found." });
    try { return await runtime.deploy(environment); }
    catch (error) { await store.updateStatus(environment.id, "error"); return reply.code(422).send({ error: error instanceof Error ? error.message : "Unable to start the mock environment." }); }
  });

  app.post<{ Params: { id: string } }>("/api/environments/:id/stop", async (request, reply) => {
    const environment = await store.get(request.params.id);
    if (!environment) return reply.code(404).send({ error: "Mock environment not found." });
    await runtime.stop(environment.id);
    return runtime.details((await store.get(environment.id))!);
  });

  app.delete<{ Params: { id: string } }>("/api/environments/:id", async (request, reply) => {
    const environment = await store.get(request.params.id);
    if (!environment) return reply.code(404).send({ error: "Mock environment not found." });
    await runtime.remove(environment.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/environments/:id/routes", async (request, reply) => {
    const current = await store.get(request.params.id);
    if (!current) return reply.code(404).send({ error: "Mock environment not found." });
    const parsed = addRouteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter a valid method, path, response, and delay." });
    const data = structuredClone(current.data);
    const route = basicRoute(data, parsed.data);
    data.routes = [...(data.routes ?? []), route];
    data.rootChildren = [...(data.rootChildren ?? []), { type: "route", uuid: route.uuid }];
    await store.updateData(current.id, data);
    const saved = await store.get(current.id);
    if (current.status === "running" && saved) {
      try { await runtime.deploy(saved); }
      catch (error) {
        await store.updateData(current.id, current.data);
        return reply.code(422).send({ error: error instanceof Error ? error.message : "The new route could not be deployed." });
      }
    }
    return reply.code(201).send(await runtime.details((await store.get(current.id))!));
  });

  app.delete<{ Params: { id: string; routeId: string } }>("/api/environments/:id/routes/:routeId", async (request, reply) => {
    const current = await store.get(request.params.id);
    if (!current) return reply.code(404).send({ error: "Mock environment not found." });
    const data = structuredClone(current.data);
    data.routes = (data.routes ?? []).filter((route: Record<string, unknown>) => route.uuid !== request.params.routeId);
    data.rootChildren = (data.rootChildren ?? []).filter((child: Record<string, unknown>) => child.uuid !== request.params.routeId);
    if (data.routes.length === current.data.routes?.length) return reply.code(404).send({ error: "Route not found." });
    await store.updateData(current.id, data);
    const saved = await store.get(current.id);
    if (current.status === "running" && saved) {
      try { await runtime.deploy(saved); }
      catch (error) {
        await store.updateData(current.id, current.data);
        return reply.code(422).send({ error: error instanceof Error ? error.message : "The route could not be removed." });
      }
    }
    return reply.code(204).send();
  });

  app.post<{ Body: unknown; Headers: { "x-mock-server-test-token"?: string } }>("/api/test/instances", async (request, reply) => {
    if (config.nodeEnv !== "test" || !config.testToken || request.headers["x-mock-server-test-token"] !== config.testToken)
      return reply.code(404).send();
    const parsed = testInstanceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Provide a valid template or environment document." });
    const template = parsed.data.templateId ? templates.get(parsed.data.templateId) : undefined;
    if (parsed.data.templateId && !template) return reply.code(404).send({ error: "Provider template not found." });
    const name = parsed.data.name?.trim().slice(0, 64) || `${template?.name ?? "Imported"} test`;
    const data = regenerateUuids(structuredClone(parsed.data.data ?? template!.data));
    data.name = name;
    data.hostname = "127.0.0.1";
    data.port = 0;
    try { await validateEnvironment(data, config.dataDir); }
    catch (error) { return reply.code(422).send({ error: "Mock Server rejected this environment document.", detail: error instanceof Error ? error.message : "Validation failed" }); }
    const environment = await store.create({
      name, slug: parsed.data.slug ?? `${slugify(parsed.data.templateId ?? name)}-${randomUUID().slice(0, 8)}`,
      provider: template?.provider ?? "Imported test fixture", data, testInstance: true,
    });
    try { return reply.code(201).send(await runtime.deploy(environment)); }
    catch (error) { await runtime.remove(environment.id); return reply.code(422).send({ error: error instanceof Error ? error.message : "Unable to start test environment." }); }
  });

  app.delete<{ Params: { id: string }; Headers: { "x-mock-server-test-token"?: string } }>("/api/test/instances/:id", async (request, reply) => {
    if (config.nodeEnv !== "test" || !config.testToken || request.headers["x-mock-server-test-token"] !== config.testToken)
      return reply.code(404).send();
    const environment = await store.get(request.params.id);
    if (!environment?.testInstance) return reply.code(404).send();
    await runtime.remove(environment.id);
    return reply.code(204).send();
  });

  const staticRoot = resolve(root, "web/dist");
  if (await stat(staticRoot).then(() => true, () => false)) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: "/", wildcard: false });
    app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
  }

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (!reply.sent) reply.code(500).send({ error: "The request could not be completed." });
  });

  await runtime.restore();
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Mock Server is listening on ${config.host}:${config.port}; runtime URLs use *.${config.baseDomain}`);

  const shutdown = async () => {
    await runtime.shutdown();
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((error) => { console.error(error); process.exit(1); });
