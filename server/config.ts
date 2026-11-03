import { resolve } from "node:path";

export type AppConfig = {
  host: string;
  port: number;
  baseDomain: string;
  databaseUrl: string;
  sessionSecret: string;
  adminEmail: string;
  adminPassword: string;
  testToken?: string;
  nodeEnv: string;
  dataDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const config: AppConfig = {
    host: env.HOST ?? "::",
    port: Number(env.PORT ?? 4310),
    baseDomain: (env.BASE_DOMAIN ?? "mockserver.localhost").toLowerCase(),
    databaseUrl: env.DATABASE_URL ?? `file:${resolve(process.cwd(), "data/mock-server.db")}`,
    sessionSecret: env.SESSION_SECRET ?? "local-development-session-secret-change-before-hosting",
    adminEmail: env.ADMIN_EMAIL ?? "admin@example.test",
    adminPassword: env.ADMIN_PASSWORD ?? "change-this-before-hosting",
    testToken: env.MOCK_SERVER_TEST_TOKEN,
    nodeEnv,
    dataDir: resolve(env.DATA_DIR ?? "data"),
  };

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("PORT must be a valid TCP port.");
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|localhost)$/.test(config.baseDomain))
    throw new Error("BASE_DOMAIN must be a DNS hostname without a scheme or port.");
  if (nodeEnv === "production" && (config.adminPassword === "change-this-before-hosting"
    || config.sessionSecret === "local-development-session-secret-change-before-hosting" || config.sessionSecret.length < 32))
    throw new Error("Set a unique ADMIN_PASSWORD and a SESSION_SECRET of at least 32 characters before production.");

  return config;
}
