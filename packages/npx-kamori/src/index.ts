#!/usr/bin/env node
/**
 * kamori — scaffold a minimal Kamori self-hosted log ingestion setup.
 *
 * Usage:
 *   npx kamori
 *   npx kamori my-project
 *   npx kamori my-project --docker
 *   npx kamori my-project --log-token secret
 *   npx kamori my-project --allowed-origins http://localhost:5173,http://localhost:3110
 *   npx kamori my-project --no-mcp       # ingest only, no MCP
 *   npx kamori my-project --yes          # non-interactive (Node from source by default)
 *
 * MCP HTTP auth follows @usekamori/mcp: Bearer via MCP_TOKEN (not INGEST_TOKEN).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_DIR,
  DEFAULT_LOG_PORT,
  DEFAULT_MCP_PORT,
  ALLOW_ALL_ORIGINS,
  DOCS_CONFIGURATION_URL,
  KAMORI_SUBDIR,
  KAMORI_GIT_URL,
  KAMORI_GIT_REF,
  dotenv,
  dockerCompose,
  dockerPlainRun,
  gitignore,
  mcpConfig,
  packageJsonDocker,
  packageJsonNode,
  parseArgsFrom,
  readmeDocker,
  readmeNode,
  npmSafeName,
  formatCurlHealthExample,
  formatCurlIngestExample,
  formatCurlStreamExample,
  resolveAllowedOrigins,
  resolveLogToken,
  resolveMcpToken,
  validateDirName,
  validatePort,
} from "./scaffold.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function write(filePath: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode });
  console.log(`  created  ${path.relative(process.cwd(), filePath)}`);
}

function npmCmd(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runOrExit(
  cmd: string,
  args: string[],
  cwd: string,
  label: string,
): void {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`\nError: ${label} failed (exit ${r.status ?? "unknown"}).`);
    process.exit(1);
  }
}

function cloneAndBuildKamori(projectDir: string): void {
  const kamoriDir = path.join(projectDir, KAMORI_SUBDIR);
  console.log(
    `\nCloning Kamori from ${KAMORI_GIT_URL} (${KAMORI_GIT_REF}) …\n`,
  );
  runOrExit(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      KAMORI_GIT_REF,
      KAMORI_GIT_URL,
      KAMORI_SUBDIR,
    ],
    projectDir,
    "git clone",
  );
  console.log(`\nInstalling dependencies in ${KAMORI_SUBDIR}/ …\n`);
  runOrExit(npmCmd(), ["install"], kamoriDir, "npm install (kamori)");
  console.log("\nBuilding @usekamori/ingest and @usekamori/mcp …\n");
  runOrExit(
    npmCmd(),
    ["run", "build", "-w", "@usekamori/ingest", "-w", "@usekamori/mcp"],
    kamoriDir,
    "npm run build (server + mcp)",
  );
  console.log("\nInstalling runner dependencies in project root …\n");
  runOrExit(npmCmd(), ["install"], projectDir, "npm install (project)");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nKamori — scaffold a Kamori log ingestion setup\n");

  const flags = parseArgsFrom(process.argv.slice(2));

  const interactive = !flags.yes && !process.env.CI && process.stdin.isTTY;

  let dirName: string;
  let logToken: string;
  let mcp: boolean;
  let useDocker: boolean;
  let interactiveMcpToken: string | undefined;
  let interactiveMcpTokenSet = false;
  let allowedOrigins: string;

  if (interactive) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      dirName =
        flags.dirName ??
        ((
          await prompt(rl, `Project directory name (default: ${DEFAULT_DIR}): `)
        ).trim() ||
          DEFAULT_DIR);

      if (flags.docker) {
        useDocker = true;
      } else {
        const d = (await prompt(rl, "Use Docker to run Kamori? (y/N): "))
          .trim()
          .toLowerCase();
        useDocker = d === "y" || d === "yes";
      }

      let interactiveLogToken: string | undefined;
      let interactiveLogTokenSet = false;
      if (flags.logToken === undefined) {
        const setLogToken = (
          await prompt(rl, "Set INGEST_TOKEN for ingest/query auth? (y/N): ")
        )
          .trim()
          .toLowerCase();
        interactiveLogTokenSet = setLogToken === "y" || setLogToken === "yes";
      }
      if (interactiveLogTokenSet) {
        interactiveLogToken = await prompt(
          rl,
          "INGEST_TOKEN value (leave blank to disable): ",
        );
      }
      logToken = resolveLogToken(
        flags,
        interactiveLogTokenSet,
        interactiveLogToken,
      );

      if (flags.noMcp) {
        mcp = false;
      } else {
        const disableRaw = (
          await prompt(rl, "Disable MCP server for Claude Code? (y/N): ")
        )
          .trim()
          .toLowerCase();
        mcp = disableRaw !== "y" && disableRaw !== "yes";
      }

      if (mcp && flags.mcpToken === undefined) {
        const setMcpToken = (
          await prompt(rl, "Set MCP_TOKEN for MCP HTTP Bearer auth? (y/N): ")
        )
          .trim()
          .toLowerCase();
        interactiveMcpTokenSet = setMcpToken === "y" || setMcpToken === "yes";
      }
      if (interactiveMcpTokenSet) {
        interactiveMcpToken = await prompt(
          rl,
          "MCP_TOKEN value (leave blank to disable): ",
        );
      }

      const interactiveAllowedOrigins = await prompt(
        rl,
        `Allowed origins for CORS (comma-separated). Leave blank to allow all origins (${ALLOW_ALL_ORIGINS}).\n> `,
      );
      allowedOrigins = resolveAllowedOrigins(flags, interactiveAllowedOrigins);
    } finally {
      rl.close();
    }
  } else {
    dirName = flags.dirName ?? DEFAULT_DIR;
    useDocker = flags.docker ?? false;
    logToken = resolveLogToken(flags, false);
    mcp = !flags.noMcp;
    interactiveMcpToken = undefined;
    allowedOrigins = resolveAllowedOrigins(flags);
  }

  const mcpToken = resolveMcpToken(
    mcp,
    flags,
    interactiveMcpTokenSet,
    interactiveMcpToken,
  );

  const logPort = flags.logPort ?? DEFAULT_LOG_PORT;
  const mcpPort = flags.mcpPort ?? DEFAULT_MCP_PORT;

  const portErr = validatePort(logPort) ?? validatePort(mcpPort);
  if (portErr) {
    console.error(`\nError: ${portErr}`);
    process.exit(1);
  }

  const nameError = validateDirName(dirName);
  if (nameError) {
    console.error(`\nError: ${nameError}`);
    process.exit(1);
  }

  const dir = path.resolve(process.cwd(), dirName);

  if (fs.existsSync(dir)) {
    console.error(`\nError: directory "${dirName}" already exists.`);
    process.exit(1);
  }

  console.log(`\nScaffolding Kamori setup in ./${dirName} …\n`);

  fs.mkdirSync(dir, { recursive: true });

  write(
    path.join(dir, ".env"),
    dotenv(mcp, logToken, mcpToken, allowedOrigins, logPort, mcpPort),
    0o600,
  );
  write(path.join(dir, ".gitignore"), gitignore());

  const dockerRunLine = dockerPlainRun(mcp, logPort, mcpPort);

  if (useDocker) {
    write(
      path.join(dir, "docker-compose.yml"),
      dockerCompose(mcp, logPort, mcpPort),
    );
    write(
      path.join(dir, "package.json"),
      packageJsonDocker(npmSafeName(dirName)),
    );
    write(
      path.join(dir, "README.md"),
      readmeDocker(
        dirName,
        logToken,
        mcp,
        mcpToken,
        allowedOrigins,
        logPort,
        mcpPort,
        dockerRunLine,
      ),
    );
  } else {
    write(
      path.join(dir, "package.json"),
      packageJsonNode(npmSafeName(dirName), mcp),
    );
    write(
      path.join(dir, "README.md"),
      readmeNode(
        dirName,
        logToken,
        mcp,
        mcpToken,
        allowedOrigins,
        logPort,
        mcpPort,
      ),
    );
  }

  if (mcp) {
    write(path.join(dir, ".mcp.json"), mcpConfig(mcpToken, mcpPort), 0o600);
  }

  write(path.join(dir, "data", "logs", ".gitkeep"), "");

  if (!useDocker) {
    cloneAndBuildKamori(dir);
  }

  console.log(`\n✅ Done! Next steps:\n`);
  console.log(`   cd ${dirName}`);
  if (useDocker) {
    console.log(`   npm start`);
    console.log(`   # or: docker compose up -d`);
    console.log(`   # plain Docker: ${dockerRunLine}`);
  } else {
    console.log(`   npm start   # ingest${mcp ? " + MCP" : ""} (loads .env)`);
  }

  if (mcp) {
    const url = `http://localhost:${mcpPort}/mcp`;
    if (mcpToken) {
      console.log(
        `   claude mcp add kamori --transport http ${url} --header "Authorization: Bearer ${mcpToken}"`,
      );
    } else {
      console.log(`   claude mcp add kamori --transport http ${url}`);
    }
    console.log(`   # Or use .mcp.json in this directory (see README)`);
  }

  console.log("\n   Example API calls (ingest / health / live tail):");
  console.log("");
  for (const line of formatCurlIngestExample(logPort, logToken).split("\n")) {
    console.log(`   ${line}`);
  }
  console.log(`   ${formatCurlHealthExample(logPort)}`);
  console.log("");
  for (const line of formatCurlStreamExample(logPort, logToken).split("\n")) {
    console.log(`   ${line}`);
  }

  if (!logToken) {
    console.log(
      "\n⚠️  INGEST_TOKEN is not set (HTTP ingest/query auth is disabled).",
    );
    console.log(`   Set it in ${dirName}/.env`);
  }
  if (mcp && !mcpToken) {
    console.log("\n⚠️  MCP_TOKEN is not set (MCP HTTP auth is disabled).");
    console.log(`   Set it in ${dirName}/.env`);
    console.log(
      `   If using .mcp.json, also set headers.Authorization to Bearer <your-secret>`,
    );
  }
  if (allowedOrigins === ALLOW_ALL_ORIGINS) {
    console.log(
      `\n⚠️  CORS is currently wide open (ALLOWED_ORIGINS=${ALLOW_ALL_ORIGINS}).`,
    );
    console.log(
      `   For production, set a comma-separated allowlist in ${dirName}/.env (ALLOWED_ORIGINS=...)`,
    );
  }
  console.log(`\n   Environment reference: ${DOCS_CONFIGURATION_URL}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
