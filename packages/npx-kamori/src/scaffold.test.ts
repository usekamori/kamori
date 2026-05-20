import { describe, expect, it } from "vitest";
import {
  ALLOW_ALL_ORIGINS,
  DOCS_CONFIGURATION_URL,
  dockerCompose,
  dotenv,
  gitignore,
  mcpConfig,
  npmSafeName,
  formatCurlHealthExample,
  formatCurlIngestExample,
  formatCurlStreamExample,
  packageJsonDocker,
  packageJsonNode,
  parseArgsFrom,
  resolveAllowedOrigins,
  resolveLogToken,
  resolveMcpToken,
  validateDirName,
  validatePort,
} from "./scaffold.js";

describe("validateDirName", () => {
  it("returns an error when the name is empty", () => {
    expect(validateDirName("")).toBe("directory name must not be empty");
  });

  it("returns an error when the name contains invalid characters", () => {
    expect(validateDirName("bad name")).toBe(
      'directory name "bad name" contains invalid characters (allowed: A-Z a-z 0-9 . _ -)',
    );
  });

  it("returns null for a valid directory name", () => {
    expect(validateDirName("my-project_1")).toBeNull();
  });
});

describe("validatePort", () => {
  it("returns an error for zero", () => {
    expect(validatePort(0)).toContain("65535");
  });

  it("returns an error for a port above 65535", () => {
    expect(validatePort(65536)).toContain("65535");
  });

  it("returns null for port 1", () => {
    expect(validatePort(1)).toBeNull();
  });

  it("returns null for port 65535", () => {
    expect(validatePort(65535)).toBeNull();
  });
});

describe("parseArgsFrom", () => {
  it("parses positional directory and boolean flags", () => {
    expect(
      parseArgsFrom([
        "my-app",
        "--yes",
        "--docker",
        "--no-mcp",
      ]),
    ).toEqual({
      dirName: "my-app",
      yes: true,
      docker: true,
      noMcp: true,
    });
  });

  it("parses token and origin flags with their values", () => {
    expect(
      parseArgsFrom([
        "--log-token",
        "secret-ingest",
        "--mcp-token",
        "secret-mcp",
        "--allowed-origins",
        "http://a,http://b",
        "-y",
      ]),
    ).toEqual({
      yes: true,
      logToken: "secret-ingest",
      mcpToken: "secret-mcp",
      allowedOrigins: "http://a,http://b",
    });
  });

  it("parses port flags", () => {
    expect(
      parseArgsFrom(["proj", "--log-port", "4000", "--mcp-port", "4001"]),
    ).toEqual({
      dirName: "proj",
      yes: false,
      logPort: 4000,
      mcpPort: 4001,
    });
  });

  it("ignores unknown flags per spec", () => {
    expect(parseArgsFrom(["--unknown", "dir"])).toEqual({
      yes: false,
      dirName: "dir",
    });
  });

  it("uses the first non-flag token only as directory name", () => {
    expect(parseArgsFrom(["first", "second"])).toEqual({
      yes: false,
      dirName: "first",
    });
  });
});

describe("resolveLogToken", () => {
  it("prefers the CLI flag over interactive", () => {
    expect(
      resolveLogToken({ yes: true, logToken: "  tok  " }, true, "ignored"),
    ).toBe("tok");
  });

  it("returns interactive value when opted in", () => {
    expect(resolveLogToken({ yes: true }, true, "  ab  ")).toBe("ab");
  });

  it("returns empty when non-interactive and no flag", () => {
    expect(resolveLogToken({ yes: true }, false)).toBe("");
  });
});

describe("resolveMcpToken", () => {
  it("returns empty when MCP is disabled", () => {
    expect(resolveMcpToken(false, { yes: true, mcpToken: "x" }, false, "y")).toBe(
      "",
    );
  });

  it("prefers the CLI flag", () => {
    expect(
      resolveMcpToken(true, { yes: true, mcpToken: "cli" }, true, "interactive"),
    ).toBe("cli");
  });

  it("returns empty in non-interactive mode without flag", () => {
    expect(resolveMcpToken(true, { yes: true }, false, undefined)).toBe("");
  });
});

describe("resolveAllowedOrigins", () => {
  it("uses the flag when set", () => {
    expect(
      resolveAllowedOrigins({ yes: true, allowedOrigins: " http://x " }),
    ).toBe("http://x");
  });

  it("maps blank interactive input to allow-all", () => {
    expect(resolveAllowedOrigins({ yes: true }, "   ")).toBe(ALLOW_ALL_ORIGINS);
  });

  it("defaults to allow-all when unspecified", () => {
    expect(resolveAllowedOrigins({ yes: true })).toBe(ALLOW_ALL_ORIGINS);
  });
});

describe("dotenv", () => {
  it("sets MCP_PORT to 0 when MCP is disabled", () => {
    const env = dotenv(false, "", "", ALLOW_ALL_ORIGINS, 3110, 3111);
    expect(env).toContain("MCP_PORT=0");
  });

  it("includes ingest and MCP tokens when MCP is enabled", () => {
    const env = dotenv(true, "a", "b", "http://localhost", 3000, 3001);
    expect(env).toContain("INGEST_TOKEN=a");
    expect(env).toContain("MCP_TOKEN=b");
    expect(env).toContain("MCP_PORT=3001");
    expect(env).toContain("PORT=3000");
    expect(env).toContain(`# Full reference: ${DOCS_CONFIGURATION_URL}`);
  });
});

describe("dockerCompose", () => {
  it("includes the Kamori image and healthcheck on the ingest port", () => {
    const yml = dockerCompose(true, 3110, 3111);
    expect(yml).toContain("image: ghcr.io/usekamori/kamori:latest");
    expect(yml).toContain('http://localhost:3110/v1/health');
    expect(yml).toContain('"3111:3111"');
  });

  it("omits the MCP port mapping when MCP is disabled", () => {
    const yml = dockerCompose(false, 3110, 3111);
    expect(yml).not.toContain('"3111:3111"');
  });
});

describe("mcpConfig", () => {
  it("adds Authorization when a token is present", () => {
    const json = mcpConfig("tok", 3111);
    expect(json).toContain('"Authorization": "Bearer tok"');
    expect(json).toContain('"http://localhost:3111/mcp"');
  });

  it("omits headers when the token is empty", () => {
    const json = mcpConfig("", 3111);
    expect(json).not.toContain("Authorization");
  });
});

describe("packageJsonDocker", () => {
  it("uses docker compose for start", () => {
    const pkg = JSON.parse(packageJsonDocker("my-pkg")) as {
      scripts: { start: string };
    };
    expect(pkg.scripts.start).toBe("docker compose up -d");
  });
});

describe("packageJsonNode", () => {
  it("includes start:mcp only when MCP is enabled", () => {
    const withMcp = JSON.parse(packageJsonNode("x", true)) as {
      scripts: Record<string, string>;
    };
    expect(withMcp.scripts["start:mcp"]).toBeDefined();
    const withoutMcp = JSON.parse(packageJsonNode("x", false)) as {
      scripts: Record<string, string>;
    };
    expect(withoutMcp.scripts["start:mcp"]).toBeUndefined();
  });
});

describe("gitignore", () => {
  it("ignores env and sqlite artifacts", () => {
    const g = gitignore();
    expect(g).toContain(".env");
    expect(g).toContain("kamori/");
  });
});

describe("npmSafeName", () => {
  it("normalizes names for npm", () => {
    expect(npmSafeName("My_App!")).toBe("my-app");
  });
});

describe("formatCurlIngestExample", () => {
  it("includes Authorization: Bearer when a token is set", () => {
    const s = formatCurlIngestExample(3110, "sec");
    expect(s).toContain("http://localhost:3110/v1/ingest");
    expect(s).toContain('Authorization: Bearer sec');
  });

  it("omits Authorization header when auth is disabled", () => {
    const s = formatCurlIngestExample(3110, "");
    expect(s).not.toContain("Authorization: Bearer");
  });
});

describe("formatCurlHealthExample", () => {
  it("uses the ingest port for /v1/health", () => {
    expect(formatCurlHealthExample(3200)).toBe(
      "curl http://localhost:3200/v1/health",
    );
  });
});

describe("formatCurlStreamExample", () => {
  it("adds Authorization: Bearer when set", () => {
    const s = formatCurlStreamExample(3110, "t");
    expect(s).toContain("/v1/stream");
    expect(s).toContain("Authorization: Bearer t");
  });

  it("is a single line when no token", () => {
    expect(formatCurlStreamExample(3110, "")).toBe(
      "curl -N http://localhost:3110/v1/stream",
    );
  });
});
