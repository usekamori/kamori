import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliEntry = path.join(packageRoot, "dist", "index.js");

function runKamori(
  cwd: string,
  args: string[],
): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    status: r.status,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? "",
  };
}

describe("kamori CLI (e2e)", () => {
  const tmpRoots: string[] = [];

  beforeAll(() => {
    const build = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "build"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
    expect(build.status).toBe(0);
    if (!fs.existsSync(cliEntry)) {
      throw new Error(`missing ${cliEntry} after build`);
    }
  });

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scaffolds a Docker project with expected files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kamori-e2e-"));
    tmpRoots.push(root);
    const name = `uf-docker-${Date.now()}`;
    const { status, stderr, stdout } = runKamori(root, [
      name,
      "--yes",
      "--docker",
      "--log-token",
      "ingest-secret",
      "--mcp-token",
      "mcp-secret",
      "--allowed-origins",
      "http://localhost:5173",
      "--log-port",
      "3200",
      "--mcp-port",
      "3201",
    ]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Example API calls");
    expect(stdout).toContain("http://localhost:3200/v1/ingest");
    expect(stdout).toContain("http://localhost:3200/v1/health");
    expect(stdout).toContain("http://localhost:3200/v1/stream");
    expect(stdout).toContain("Authorization: Bearer ingest-secret");

    const proj = path.join(root, name);
    expect(fs.existsSync(path.join(proj, ".env"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "docker-compose.yml"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(proj, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "data", "logs", ".gitkeep"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(proj, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "kamori"))).toBe(false);

    const env = fs.readFileSync(path.join(proj, ".env"), "utf8");
    expect(env).toContain("INGEST_TOKEN=ingest-secret");
    expect(env).toContain("MCP_TOKEN=mcp-secret");
    expect(env).toContain("ALLOWED_ORIGINS=http://localhost:5173");
    expect(env).toContain("PORT=3200");
    expect(env).toContain("MCP_PORT=3201");

    const compose = fs.readFileSync(
      path.join(proj, "docker-compose.yml"),
      "utf8",
    );
    expect(compose).toContain("ghcr.io/usekamori/kamori:latest");
    expect(compose).toContain('"3200:3200"');
    expect(compose).toContain('"3201:3201"');
  });

  it("scaffolds without MCP when --no-mcp is passed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kamori-e2e-"));
    tmpRoots.push(root);
    const name = `uf-nomcp-${Date.now()}`;
    const { status } = runKamori(root, [name, "--yes", "--docker", "--no-mcp"]);
    expect(status).toBe(0);

    const proj = path.join(root, name);
    expect(fs.existsSync(path.join(proj, ".mcp.json"))).toBe(false);
    const env = fs.readFileSync(path.join(proj, ".env"), "utf8");
    expect(env).toContain("MCP_PORT=0");
  });

  it("exits with code 1 when the directory already exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kamori-e2e-"));
    tmpRoots.push(root);
    const name = `uf-exists-${Date.now()}`;
    fs.mkdirSync(path.join(root, name));
    const { status, stderr } = runKamori(root, [name, "--yes", "--docker"]);
    expect(status).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("exits with code 1 for an invalid directory name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kamori-e2e-"));
    tmpRoots.push(root);
    const { status, stderr } = runKamori(root, [
      "bad name",
      "--yes",
      "--docker",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("invalid characters");
  });

  it("exits with code 1 for an out-of-range port", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kamori-e2e-"));
    tmpRoots.push(root);
    const { status, stderr } = runKamori(root, [
      "ok",
      "--yes",
      "--docker",
      "--log-port",
      "0",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("port");
  });
});
