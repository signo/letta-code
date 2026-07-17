import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __testResetRuntimeVersion,
  __testSetRuntimeVersion,
  LETTA_CODE_DESKTOP_VERSION,
  LETTA_DESKTOP_MODE,
} from "@/mods/engine-compatibility";
import {
  getManagedModPackageRootRelativePathForSource,
  listManagedModPackages,
  removeManagedModPackage,
  resolveManagedModPackages,
  setManagedModPackageEnabled,
  upsertManagedModPackage,
} from "@/mods/package-registry";

const tempRoots: string[] = [];
const originalDesktopMode = process.env[LETTA_DESKTOP_MODE];
const originalDesktopVersion = process.env[LETTA_CODE_DESKTOP_VERSION];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-package-registry-"));
  tempRoots.push(dir);
  return dir;
}

function writePackage(params: {
  capabilities?: string[];
  enabled: boolean;
  engines?: { lettaCodeCli?: string; lettaCodeDesktop?: string };
  modsRoot: string;
  root: string;
  source: string;
  version: string;
}): string {
  const packageRoot = path.join(params.modsRoot, ...params.root.split("/"));
  mkdirSync(path.join(packageRoot, "mods"), { recursive: true });
  writeFileSync(path.join(packageRoot, "mods", "index.ts"), "export {};\n");
  writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        letta: {
          manifestVersion: 1,
          mods: ["mods/index.ts"],
          ...(params.capabilities ? { capabilities: params.capabilities } : {}),
          ...(params.engines ? { engines: params.engines } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  return packageRoot;
}

function writeRegistry(
  modsRoot: string,
  packages: Array<{
    enabled: boolean;
    root: string;
    source: string;
    version: string;
  }>,
): void {
  writeFileSync(
    path.join(modsRoot, "packages.json"),
    `${JSON.stringify(
      {
        packages: packages.map((pkg) => ({
          ...pkg,
          entries: ["mods/index.ts"],
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function readRegistry(modsRoot: string): {
  packages: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path.join(modsRoot, "packages.json"), "utf8"));
}

afterEach(() => {
  __testResetRuntimeVersion();
  if (originalDesktopMode === undefined) {
    delete process.env[LETTA_DESKTOP_MODE];
  } else {
    process.env[LETTA_DESKTOP_MODE] = originalDesktopMode;
  }
  if (originalDesktopVersion === undefined) {
    delete process.env[LETTA_CODE_DESKTOP_VERSION];
  } else {
    process.env[LETTA_CODE_DESKTOP_VERSION] = originalDesktopVersion;
  }
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("managed mod package registry", () => {
  test("derives npm package roots from valid package sources", () => {
    expect(getManagedModPackageRootRelativePathForSource("npm:my-mod")).toBe(
      "packages/npm/my-mod",
    );
    expect(
      getManagedModPackageRootRelativePathForSource("npm:@caren/my-mod"),
    ).toBe("packages/npm/@caren/my-mod");
    expect(
      getManagedModPackageRootRelativePathForSource(
        "git:https://github.com/caren/my-mod",
      ),
    ).toBe("packages/git/github.com/caren/my-mod");

    for (const source of [
      "npm:@caren",
      "npm:my/mod",
      "npm:../my-mod",
      "npm:.",
      "npm:",
      "git:https://github.com/caren",
      "git:https://gitlab.com/caren/my-mod",
      "path:my-mod",
    ]) {
      expect(getManagedModPackageRootRelativePathForSource(source)).toBeNull();
    }
  });

  test("upsert derives root and creates registry", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");

    const result = upsertManagedModPackage({
      entries: ["mods/index.ts"],
      modsRoot,
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });

    expect(result).toMatchObject({ replaced: false, removedDuplicates: 0 });
    expect(readRegistry(modsRoot).packages).toEqual([
      {
        source: "npm:@caren/my-mod",
        version: "0.1.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/index.ts"],
      },
    ]);
  });

  test("upsert replaces same source in place and removes duplicates", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/first",
        source: "npm:first",
        version: "0.1.0",
      },
      {
        enabled: false,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
      {
        enabled: true,
        root: "packages/npm/last",
        source: "npm:last",
        version: "0.1.0",
      },
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.0.1",
      },
    ]);

    const result = upsertManagedModPackage({
      enabled: true,
      entries: ["mods/next.ts"],
      modsRoot,
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });

    expect(result).toMatchObject({ replaced: true, removedDuplicates: 1 });
    expect(readRegistry(modsRoot).packages).toEqual([
      expect.objectContaining({ source: "npm:first" }),
      {
        source: "npm:@caren/my-mod",
        version: "0.2.0",
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        entries: ["mods/next.ts"],
      },
      expect.objectContaining({ source: "npm:last" }),
    ]);
  });

  test("lists enabled and disabled packages with manifest capabilities", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writePackage({
      capabilities: ["commands"],
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/enabled-mod",
      source: "npm:@caren/enabled-mod",
      version: "0.1.0",
    });
    writePackage({
      capabilities: ["tools"],
      enabled: false,
      modsRoot,
      root: "packages/npm/@caren/disabled-mod",
      source: "npm:@caren/disabled-mod",
      version: "0.2.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren/enabled-mod",
        source: "npm:@caren/enabled-mod",
        version: "0.1.0",
      },
      {
        enabled: false,
        root: "packages/npm/@caren/disabled-mod",
        source: "npm:@caren/disabled-mod",
        version: "0.2.0",
      },
    ]);

    expect(listManagedModPackages(modsRoot)).toMatchObject({
      diagnostics: [],
      packages: [
        {
          capabilities: ["commands"],
          enabled: true,
          source: "npm:@caren/enabled-mod",
          version: "0.1.0",
        },
        {
          capabilities: ["tools"],
          enabled: false,
          source: "npm:@caren/disabled-mod",
          version: "0.2.0",
        },
      ],
      registryExists: true,
    });
  });

  test("enables and disables packages by source", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writePackage({
      enabled: false,
      modsRoot,
      root: "packages/npm/@caren/my-mod",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: false,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    expect(
      setManagedModPackageEnabled({
        enabled: true,
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }).package,
    ).toMatchObject({ enabled: true, source: "npm:@caren/my-mod" });
    expect(readRegistry(modsRoot).packages[0]?.enabled).toBe(true);

    setManagedModPackageEnabled({
      enabled: false,
      modsRoot,
      specifier: "npm:@caren/my-mod@0.1.0",
    });
    expect(readRegistry(modsRoot).packages[0]?.enabled).toBe(false);
  });

  test("remove deletes registry entry and package root", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    const packageRoot = writePackage({
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/my-mod",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    const result = removeManagedModPackage({
      modsRoot,
      specifier: "npm:@caren/my-mod",
    });

    expect(result.removedRoot).toBe(packageRoot);
    expect(existsSync(packageRoot)).toBe(false);
    expect(readRegistry(modsRoot).packages).toEqual([]);
  });

  test("remove refuses roots outside the expected package path", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    const modFilePath = path.join(modsRoot, "mod-file.ts");
    writeFileSync(modFilePath, "export {};\n");
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "mod-file.ts",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    expect(() =>
      removeManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow("Refusing to remove npm:@caren/my-mod@0.1.0");
    expect(existsSync(modFilePath)).toBe(true);
    expect(readRegistry(modsRoot).packages).toHaveLength(1);
  });

  test("remove refuses broad package parent roots", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(path.join(modsRoot, "packages", "npm", "@caren"), {
      recursive: true,
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
    ]);

    expect(() =>
      removeManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow("does not match expected package root");
    expect(existsSync(path.join(modsRoot, "packages", "npm"))).toBe(true);
    expect(readRegistry(modsRoot).packages).toHaveLength(1);
  });

  test("remove refuses scoped namespace package sources", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    const scopedRoot = path.join(modsRoot, "packages", "npm", "@caren");
    mkdirSync(scopedRoot, { recursive: true });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren",
        source: "npm:@caren",
        version: "0.1.0",
      },
    ]);

    expect(() =>
      removeManagedModPackage({
        modsRoot,
        specifier: "npm:@caren@0.1.0",
      }),
    ).toThrow("does not match expected package root");
    expect(existsSync(scopedRoot)).toBe(true);
    expect(readRegistry(modsRoot).packages).toHaveLength(1);
  });

  test("source-only spec errors when multiple versions match", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    writePackage({
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/my-mod-1",
      source: "npm:@caren/my-mod",
      version: "0.1.0",
    });
    writePackage({
      enabled: true,
      modsRoot,
      root: "packages/npm/@caren/my-mod-2",
      source: "npm:@caren/my-mod",
      version: "0.2.0",
    });
    writeRegistry(modsRoot, [
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod-1",
        source: "npm:@caren/my-mod",
        version: "0.1.0",
      },
      {
        enabled: true,
        root: "packages/npm/@caren/my-mod-2",
        source: "npm:@caren/my-mod",
        version: "0.2.0",
      },
    ]);

    expect(() =>
      setManagedModPackageEnabled({
        enabled: false,
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow("Multiple versions match npm:@caren/my-mod");

    setManagedModPackageEnabled({
      enabled: false,
      modsRoot,
      specifier: "npm:@caren/my-mod@0.2.0",
    });
    expect(readRegistry(modsRoot).packages.map((pkg) => pkg.enabled)).toEqual([
      true,
      false,
    ]);
  });

  test("malformed registry errors without writing", () => {
    const root = createTempDir();
    const modsRoot = path.join(root, "mods");
    mkdirSync(modsRoot, { recursive: true });
    const registryPath = path.join(modsRoot, "packages.json");
    writeFileSync(registryPath, "{\n");

    expect(() =>
      setManagedModPackageEnabled({
        enabled: false,
        modsRoot,
        specifier: "npm:@caren/my-mod",
      }),
    ).toThrow();
    expect(readFileSync(registryPath, "utf8")).toBe("{\n");
  });
});

describe("engine compatibility — registry", () => {
  describe("resolveManagedModPackages", () => {
    test("registers zero entries/capabilities for incompatible package", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        engines: { lettaCodeCli: ">=0.29.0" },
        modsRoot,
        root: "packages/npm/@caren/incompatible-mod",
        source: "npm:@caren/incompatible-mod",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/incompatible-mod",
          source: "npm:@caren/incompatible-mod",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = resolveManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.error.message).toContain(
        "requires Letta Code CLI",
      );
      expect(result.diagnostics[0]?.error.message).toContain(
        "npm:@caren/incompatible-mod",
      );
      expect(result.diagnostics[0]?.error.message).toContain("1.0.0");
    });

    test("registers entries/capabilities for compatible package", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        capabilities: ["commands"],
        enabled: true,
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        root: "packages/npm/@caren/compatible-mod",
        source: "npm:@caren/compatible-mod",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/compatible-mod",
          source: "npm:@caren/compatible-mod",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = resolveManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(1);
      expect(result.files).toHaveLength(1);
      expect(result.diagnostics).toHaveLength(0);
    });

    test("loads independent packages when one is incompatible", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        engines: { lettaCodeCli: ">=0.29.0" },
        modsRoot,
        root: "packages/npm/@caren/incompatible-mod",
        source: "npm:@caren/incompatible-mod",
        version: "1.0.0",
      });
      writePackage({
        enabled: true,
        modsRoot,
        root: "packages/npm/@caren/compatible-no-deps-mod",
        source: "npm:@caren/compatible-no-deps-mod",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/incompatible-mod",
          source: "npm:@caren/incompatible-mod",
          version: "1.0.0",
        },
        {
          enabled: true,
          root: "packages/npm/@caren/compatible-no-deps-mod",
          source: "npm:@caren/compatible-no-deps-mod",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = resolveManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]?.source).toBe(
        "npm:@caren/compatible-no-deps-mod",
      );
      expect(result.files).toHaveLength(1);
      expect(result.diagnostics).toHaveLength(1);
    });

    test("package with undeclared engines is compatible (regression)", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        modsRoot,
        root: "packages/npm/@caren/legacy-mod",
        source: "npm:@caren/legacy-mod",
        version: "0.5.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/legacy-mod",
          source: "npm:@caren/legacy-mod",
          version: "0.5.0",
        },
      ]);
      __testSetRuntimeVersion("0.27.0");

      const result = resolveManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(1);
      expect(result.diagnostics).toHaveLength(0);
    });

    test("disabled package with engines is not checked (not applicable)", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: false,
        engines: { lettaCodeCli: ">=0.29.0" },
        modsRoot,
        root: "packages/npm/@caren/disabled-incompatible",
        source: "npm:@caren/disabled-incompatible",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: false,
          root: "packages/npm/@caren/disabled-incompatible",
          source: "npm:@caren/disabled-incompatible",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = resolveManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      // No diagnostic because disabled packages are not checked
      expect(result.diagnostics).toHaveLength(0);
    });

    test("applies explicit Desktop evidence during package resolution", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        engines: { lettaCodeDesktop: ">=0.15.0" },
        modsRoot,
        root: "packages/npm/@caren/desktop-mod",
        source: "npm:@caren/desktop-mod",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/desktop-mod",
          source: "npm:@caren/desktop-mod",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");
      process.env[LETTA_DESKTOP_MODE] = "1";
      process.env[LETTA_CODE_DESKTOP_VERSION] = "0.14.0";

      const result = resolveManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      expect(result.diagnostics[0]?.error.message).toContain(
        "requires Letta Code Desktop",
      );
    });
  });

  describe("listManagedModPackages", () => {
    test("reports engine incompatibility as diagnostic without hiding package", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        engines: { lettaCodeCli: ">=0.29.0" },
        modsRoot,
        root: "packages/npm/@caren/incompatible-mod",
        source: "npm:@caren/incompatible-mod",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/incompatible-mod",
          source: "npm:@caren/incompatible-mod",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = listManagedModPackages(modsRoot);
      // Package is listed (not hidden)
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]?.source).toBe("npm:@caren/incompatible-mod");
      expect(result.packages[0]?.version).toBe("1.0.0");
      expect(result.packages[0]?.enabled).toBe(true);
      // Diagnostic is present
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.error.message).toContain(
        "requires Letta Code CLI",
      );
    });

    test("enabled flag preserved for compatible package", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        root: "packages/npm/@caren/compatible-mod",
        source: "npm:@caren/compatible-mod",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/compatible-mod",
          source: "npm:@caren/compatible-mod",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = listManagedModPackages(modsRoot);
      expect(result.packages[0]?.enabled).toBe(true);
      expect(result.diagnostics).toHaveLength(0);
    });

    test("compatible and incompatible packages in same list", () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      mkdirSync(modsRoot, { recursive: true });
      writePackage({
        enabled: true,
        engines: { lettaCodeCli: ">=0.29.0" },
        modsRoot,
        root: "packages/npm/@caren/incompatible",
        source: "npm:@caren/incompatible",
        version: "1.0.0",
      });
      writePackage({
        enabled: true,
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        root: "packages/npm/@caren/compatible",
        source: "npm:@caren/compatible",
        version: "1.0.0",
      });
      writeRegistry(modsRoot, [
        {
          enabled: true,
          root: "packages/npm/@caren/incompatible",
          source: "npm:@caren/incompatible",
          version: "1.0.0",
        },
        {
          enabled: true,
          root: "packages/npm/@caren/compatible",
          source: "npm:@caren/compatible",
          version: "1.0.0",
        },
      ]);
      __testSetRuntimeVersion("0.28.8");

      const result = listManagedModPackages(modsRoot);
      expect(result.packages).toHaveLength(2);
      const incompatible = result.packages.find(
        (p) => p.source === "npm:@caren/incompatible",
      );
      const compatible = result.packages.find(
        (p) => p.source === "npm:@caren/compatible",
      );
      expect(incompatible?.enabled).toBe(true);
      expect(compatible?.enabled).toBe(true);
      expect(
        result.diagnostics.some((d) =>
          d.error.message.includes("incompatible"),
        ),
      ).toBe(true);
    });
  });
});
