#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const version = "0.1.0";

function usage() {
  process.stdout.write(`mock-server ${version}

Start the environments declared by the project config and keep them available:
  mock-server start [--project <directory>] [--config <file>]
  mock-server project start [--project <directory>] [--config <file>]

Required environment:
  MOCK_SERVER_TOKEN   Project token created from the server dashboard
  MOCK_SERVER_URL     Server URL, unless it is set in mock-server.config.json
`);
}

function parseArgs(args) {
  let command = args.shift();
  if (command === "project") command = args.shift();
  if (command === "--help" || command === "-h" || !command) return { help: true };
  if (command !== "start") throw new Error(`Unknown command: ${command}`);
  let projectDir = process.cwd();
  let configFile;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--project") {
      const value = args.shift();
      if (!value) throw new Error("--project requires a directory.");
      projectDir = resolve(value);
    } else if (arg === "--config") {
      const value = args.shift();
      if (!value) throw new Error("--config requires a file path.");
      configFile = resolve(value);
    }
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { projectDir, configFile };
}

async function request(serverUrl, token, path, body) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Server request failed (${response.status})`);
  return payload;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const configPath = options.configFile ?? resolve(options.projectDir, "mock-server.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config || typeof config.name !== "string" || !Array.isArray(config.environments) || !config.environments.length)
    throw new Error(`${configPath} must define a project name and at least one environment.`);
  const token = process.env.MOCK_SERVER_TOKEN;
  if (!token) throw new Error("Set MOCK_SERVER_TOKEN using the project token from the server dashboard.");
  const serverUrl = config.server ?? process.env.MOCK_SERVER_URL;
  if (!serverUrl) throw new Error("Set MOCK_SERVER_URL or add a server URL to mock-server.config.json.");
  const parsedServerUrl = new URL(serverUrl);
  if (!(["http:", "https:"].includes(parsedServerUrl.protocol)) || parsedServerUrl.username || parsedServerUrl.password)
    throw new Error("Use an HTTP or HTTPS server URL without embedded credentials.");
  const normalizedServerUrl = parsedServerUrl.toString();
  const configDirectory = dirname(configPath);
  const environments = await Promise.all(config.environments.map(async (environment) => {
    const templateId = environment.templateId ?? environment.template;
    if (typeof environment.file === "string") {
      const data = JSON.parse(await readFile(resolve(configDirectory, environment.file), "utf8"));
      return { name: environment.name ?? data.name, slug: environment.slug, data };
    }
    if (typeof templateId === "string") return { name: environment.name, slug: environment.slug, templateId };
    if (environment.data && typeof environment.data === "object") return environment;
    throw new Error(`Environment in ${configPath} must set template or file.`);
  }));

  const started = await request(normalizedServerUrl, token, "/api/cli/start", { name: config.name, environments });
  process.stdout.write(`Project ${config.name} is active. Use these base URLs in your app configuration:\n`);
  for (const environment of started.environments ?? []) process.stdout.write(`  ${environment.name}: ${environment.url}\n`);
  process.stdout.write("Press Ctrl+C to stop the project environments.\n");

  let stopping = false;
  let heartbeatTimer;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    clearTimeout(heartbeatTimer);
    process.stdout.write(`\nStopping ${config.name} (${signal})...\n`);
    try { await request(normalizedServerUrl, token, "/api/cli/stop"); }
    catch (error) { process.stderr.write(`Could not notify the server: ${error.message}\n`); }
    process.exit(0);
  }
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  async function heartbeat() {
    if (stopping) return;
    try {
      await request(normalizedServerUrl, token, "/api/cli/heartbeat");
    } catch (error) {
      process.stderr.write(`Project heartbeat failed: ${error.message}\n`);
    }
    if (!stopping) heartbeatTimer = setTimeout(() => void heartbeat(), 10_000);
  }
  heartbeatTimer = setTimeout(() => void heartbeat(), 10_000);
  await new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n\n`);
  usage();
  process.exitCode = 1;
});
