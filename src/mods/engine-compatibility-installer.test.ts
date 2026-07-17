import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import {
  __testResetRuntimeVersion,
  __testSetRuntimeVersion,
  LETTA_CODE_DESKTOP_VERSION,
  LETTA_DESKTOP_MODE,
} from "@/mods/engine-compatibility";
import {
  __testOverrideNpmManagedModPackageInstaller,
  installGitManagedModPackage,
  installLocalManagedModPackage,
  installNpmManagedModPackage,
  updateGitManagedModPackage,
  updateNpmManagedModPackage,
} from "@/mods/package-installer";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "letta-engine-installer-"));
  tempRoots.push(dir);
  return dir;
}

function readRegistry(modsRoot: string): {
  packages: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path.join(modsRoot, "packages.json"), "utf8"));
}

afterEach(() => {
  __testOverrideNpmManagedModPackageInstaller({});
  __testResetRuntimeVersion();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function writeLocalPackageWithEngines(params: {
  engines?: { lettaCodeCli?: string; lettaCodeDesktop?: string };
  modsRoot: string;
  packageRoot: string;
  version?: string;
}): void {
  const entries = ["mods/index.ts"];
  mkdirSync(params.packageRoot, { recursive: true });
  for (const entry of entries) {
    const entryPath = path.join(params.packageRoot, ...entry.split("/"));
    mkdirSync(path.dirname(entryPath), { recursive: true });
    writeFileSync(
      entryPath,
      `export const value = ${JSON.stringify(entry)};\n`,
    );
  }
  writeFileSync(
    path.join(params.packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@caren/incompatible-mod",
        version: params.version ?? "1.0.0",
        letta: {
          manifestVersion: 1,
          mods: entries,
          ...(params.engines ? { engines: params.engines } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
}

describe("engine compatibility — installer", () => {
  describe("local install", () => {
    test("fails without mutation when CLI version does not satisfy range", () => {
      const root = createTempDir();
      const packageRoot = path.join(root, "source");
      const modsRoot = path.join(root, "mods");
      writeLocalPackageWithEngines({
        engines: { lettaCodeCli: ">=0.29.0" },
        modsRoot,
        packageRoot,
      });
      // Simulate CLI 0.28.8 (below required >=0.29.0)
      __testSetRuntimeVersion("0.28.8");

      expect(() =>
        installLocalManagedModPackage({
          modsRoot,
          packageDirectory: packageRoot,
        }),
      ).toThrow(/requires Letta Code CLI/);
      expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
      expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
    });

    test("succeeds when CLI version satisfies declared range", () => {
      const root = createTempDir();
      const packageRoot = path.join(root, "source");
      const modsRoot = path.join(root, "mods");
      writeLocalPackageWithEngines({
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        packageRoot,
      });
      __testSetRuntimeVersion("0.28.8");

      const result = installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      });
      expect(result.root).toBeDefined();
      expect(readRegistry(modsRoot).packages).toHaveLength(1);
    });

    test("succeeds when no engines are declared (regression)", () => {
      const root = createTempDir();
      const packageRoot = path.join(root, "source");
      const modsRoot = path.join(root, "mods");
      writeLocalPackageWithEngines({ modsRoot, packageRoot });
      __testSetRuntimeVersion("0.28.8");

      const result = installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      });
      expect(result.root).toBeDefined();
    });

    test("fails without mutation when Desktop version does not satisfy range in desktop mode", () => {
      const root = createTempDir();
      const packageRoot = path.join(root, "source");
      const modsRoot = path.join(root, "mods");
      writeLocalPackageWithEngines({
        engines: { lettaCodeDesktop: ">=0.15.0" },
        modsRoot,
        packageRoot,
      });
      __testSetRuntimeVersion("0.28.8");
      // Desktop mode with Desktop version 0.11.0 (below required >=0.15.0)
      const OLD_DESKTOP_MODE = process.env[LETTA_DESKTOP_MODE];
      const OLD_DESKTOP_VERSION = process.env[LETTA_CODE_DESKTOP_VERSION];
      process.env[LETTA_DESKTOP_MODE] = "1";
      process.env[LETTA_CODE_DESKTOP_VERSION] = "0.11.0";
      try {
        expect(() =>
          installLocalManagedModPackage({
            modsRoot,
            packageDirectory: packageRoot,
          }),
        ).toThrow(/requires Letta Code Desktop/);
        expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
        expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
      } finally {
        if (OLD_DESKTOP_MODE !== undefined) {
          process.env[LETTA_DESKTOP_MODE] = OLD_DESKTOP_MODE;
        } else {
          delete process.env[LETTA_DESKTOP_MODE];
        }
        if (OLD_DESKTOP_VERSION !== undefined) {
          process.env[LETTA_CODE_DESKTOP_VERSION] = OLD_DESKTOP_VERSION;
        } else {
          delete process.env[LETTA_CODE_DESKTOP_VERSION];
        }
      }
    });
  });

  describe("npm install", () => {
    test("fails without mutation when CLI version does not satisfy range", async () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      __testSetRuntimeVersion("0.27.0");
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          const nodeModulesDir = path.join(
            options.cwd.toString(),
            "node_modules",
          );
          const packageDir = path.join(
            nodeModulesDir,
            "@caren",
            "incompatible-mod",
          );
          writeLocalPackageWithEngines({
            engines: { lettaCodeCli: ">=0.28.0" },
            modsRoot,
            packageRoot: packageDir,
          });
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      await expect(
        installNpmManagedModPackage({
          modsRoot,
          specifier: "npm:@caren/incompatible-mod",
        }),
      ).rejects.toThrow(/requires Letta Code CLI/);
      expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
      expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
    });

    test("succeeds when CLI version satisfies declared range", async () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      __testSetRuntimeVersion("0.28.8");
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          const nodeModulesDir = path.join(
            options.cwd.toString(),
            "node_modules",
          );
          const packageDir = path.join(
            nodeModulesDir,
            "@caren",
            "compatible-mod",
          );
          writeLocalPackageWithEngines({
            engines: { lettaCodeCli: ">=0.28.0" },
            modsRoot,
            packageRoot: packageDir,
          });
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      const result = await installNpmManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/compatible-mod",
      });
      expect(result.root).toBeDefined();
    });
  });

  describe("git install", () => {
    test("fails without mutation when CLI version does not satisfy range", async () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      __testSetRuntimeVersion("0.27.0");
      __testOverrideNpmManagedModPackageInstaller({
        gitSpawnImpl: (_cmd, args) => {
          if (args[0] === "clone") {
            const cloneDir = String(args.at(-1));
            writeLocalPackageWithEngines({
              engines: { lettaCodeCli: ">=0.28.0" },
              modsRoot,
              packageRoot: cloneDir,
            });
          }
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          queueMicrotask(() => {
            if (args[0] === "rev-parse") {
              child.stdout?.emit("data", "abc123\n");
            }
            child.emit("exit", 0);
          });
          return child;
        },
      });

      await expect(
        installGitManagedModPackage({
          modsRoot,
          specifier: "https://github.com/caren/incompatible-mod",
        }),
      ).rejects.toThrow(/requires Letta Code CLI/);
      expect(existsSync(path.join(modsRoot, "packages"))).toBe(false);
      expect(existsSync(path.join(modsRoot, "packages.json"))).toBe(false);
    });

    test("succeeds when CLI version satisfies declared range", async () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      __testSetRuntimeVersion("0.28.8");
      __testOverrideNpmManagedModPackageInstaller({
        gitSpawnImpl: (_cmd, args) => {
          if (args[0] === "clone") {
            const cloneDir = String(args.at(-1));
            writeLocalPackageWithEngines({
              engines: { lettaCodeCli: ">=0.28.0" },
              modsRoot,
              packageRoot: cloneDir,
            });
          }
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          queueMicrotask(() => {
            if (args[0] === "rev-parse") {
              child.stdout?.emit("data", "abc123\n");
            }
            child.emit("exit", 0);
          });
          return child;
        },
      });

      const result = await installGitManagedModPackage({
        modsRoot,
        specifier: "https://github.com/caren/compatible-mod",
      });
      expect(result.root).toBeDefined();
    });
  });

  describe("update", () => {
    test("incompatible update preserves old package and registry bytes", async () => {
      const root = createTempDir();
      const packageRoot = path.join(root, "source");
      const modsRoot = path.join(root, "mods");
      writeLocalPackageWithEngines({
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        packageRoot,
      });
      __testSetRuntimeVersion("0.28.8");
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      });

      // Write old registry bytes for comparison
      const oldRegistryBytes = readFileSync(
        path.join(modsRoot, "packages.json"),
        "utf8",
      );
      const oldPackageRoot = path.join(
        modsRoot,
        "packages",
        "npm",
        "@caren",
        "incompatible-mod",
      );

      // Simulate updated package with incompatible range
      writeLocalPackageWithEngines({
        engines: { lettaCodeCli: ">=0.30.0" },
        modsRoot,
        packageRoot,
      });
      // Now the CLI is 0.28.8, below required >=0.30.0
      __testSetRuntimeVersion("0.28.8");
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          const nodeModulesDir = path.join(
            options.cwd.toString(),
            "node_modules",
          );
          const newPackageDir = path.join(
            nodeModulesDir,
            "@caren",
            "incompatible-mod",
          );
          writeLocalPackageWithEngines({
            engines: { lettaCodeCli: ">=0.30.0" },
            modsRoot,
            packageRoot: newPackageDir,
          });
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      await expect(
        updateNpmManagedModPackage({
          modsRoot,
          specifier: "npm:@caren/incompatible-mod@2.0.0",
        }),
      ).rejects.toThrow(/requires Letta Code CLI/);

      // Old package and registry must be preserved
      expect(existsSync(oldPackageRoot)).toBe(true);
      const newRegistryBytes = readFileSync(
        path.join(modsRoot, "packages.json"),
        "utf8",
      );
      expect(newRegistryBytes).toBe(oldRegistryBytes);
      // Registry still shows old version
      const registry = JSON.parse(newRegistryBytes);
      expect(registry.packages[0]?.version).toBe("1.0.0");
    });

    test("incompatible git update preserves old package and registry", async () => {
      const root = createTempDir();
      const modsRoot = path.join(root, "mods");
      const specifier = "https://github.com/caren/incompatible-mod";
      __testSetRuntimeVersion("0.28.8");

      function installGitFixture(requiredRange: string): void {
        __testOverrideNpmManagedModPackageInstaller({
          gitSpawnImpl: (_cmd, args) => {
            const child = new EventEmitter() as ChildProcess;
            Object.assign(child, {
              stdout: new PassThrough(),
              stderr: new PassThrough(),
            });
            if (args[0] === "clone") {
              writeLocalPackageWithEngines({
                engines: { lettaCodeCli: requiredRange },
                modsRoot,
                packageRoot: String(args.at(-1)),
              });
            }
            queueMicrotask(() => {
              if (args[0] === "rev-parse") {
                child.stdout?.emit("data", "abc123\n");
              }
              child.emit("exit", 0);
            });
            return child;
          },
        });
      }

      installGitFixture(">=0.28.0");
      const installed = await installGitManagedModPackage({
        modsRoot,
        specifier,
      });
      const oldRegistry = readFileSync(
        path.join(modsRoot, "packages.json"),
        "utf8",
      );
      const oldPackageJson = readFileSync(
        path.join(installed.root, "package.json"),
        "utf8",
      );

      installGitFixture(">=0.30.0");
      await expect(
        updateGitManagedModPackage({ modsRoot, specifier }),
      ).rejects.toThrow(/requires Letta Code CLI/);
      expect(readFileSync(path.join(modsRoot, "packages.json"), "utf8")).toBe(
        oldRegistry,
      );
      expect(
        readFileSync(path.join(installed.root, "package.json"), "utf8"),
      ).toBe(oldPackageJson);
    });

    test("compatible update succeeds", async () => {
      const root = createTempDir();
      const packageRoot = path.join(root, "source");
      const modsRoot = path.join(root, "mods");
      writeLocalPackageWithEngines({
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        packageRoot,
      });
      __testSetRuntimeVersion("0.28.8");
      installLocalManagedModPackage({
        modsRoot,
        packageDirectory: packageRoot,
      });

      // Updated package still compatible
      writeLocalPackageWithEngines({
        engines: { lettaCodeCli: ">=0.28.0" },
        modsRoot,
        packageRoot,
      });
      __testOverrideNpmManagedModPackageInstaller({
        spawnImpl: (_cmd, _args, options) => {
          if (!options.cwd) throw new Error("expected cwd");
          const nodeModulesDir = path.join(
            options.cwd.toString(),
            "node_modules",
          );
          const newPackageDir = path.join(
            nodeModulesDir,
            "@caren",
            "incompatible-mod",
          );
          writeLocalPackageWithEngines({
            engines: { lettaCodeCli: ">=0.28.0" },
            modsRoot,
            packageRoot: newPackageDir,
            version: "2.0.0",
          });
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          });
          queueMicrotask(() => child.emit("exit", 0));
          return child;
        },
      });

      const result = await updateNpmManagedModPackage({
        modsRoot,
        specifier: "npm:@caren/incompatible-mod@2.0.0",
      });
      expect(result.version).toBe("2.0.0");
    });
  });
});
