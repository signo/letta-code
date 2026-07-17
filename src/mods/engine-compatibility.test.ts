import { afterEach, describe, expect, test } from "bun:test";
import {
  __testResetRuntimeVersion,
  checkEngineCompatibility,
  getDesktopVersion,
  getHostEvidence,
  getHostMode,
  LETTA_CODE_DESKTOP_VERSION,
  LETTA_DESKTOP_MODE,
} from "@/mods/engine-compatibility";
import type { LettaPackageManifest } from "@/mods/package-manifest";

function createManifest(engines?: {
  lettaCodeCli?: string;
  lettaCodeDesktop?: string;
}): LettaPackageManifest {
  return {
    manifestVersion: 1,
    mods: ["./mods/index.ts"],
    ...(engines ? { engines } : {}),
  };
}

describe("engine compatibility", () => {
  describe("getHostMode", () => {
    const OLD_DESKTOP_MODE = process.env[LETTA_DESKTOP_MODE];

    afterEach(() => {
      if (OLD_DESKTOP_MODE !== undefined) {
        process.env[LETTA_DESKTOP_MODE] = OLD_DESKTOP_MODE;
      } else {
        delete process.env[LETTA_DESKTOP_MODE];
      }
    });

    test("returns standalone when LETTA_DESKTOP_MODE is not set", () => {
      delete process.env[LETTA_DESKTOP_MODE];
      expect(getHostMode()).toBe("standalone");
    });

    test("returns standalone when LETTA_DESKTOP_MODE is empty", () => {
      process.env[LETTA_DESKTOP_MODE] = "";
      expect(getHostMode()).toBe("standalone");
    });

    test("returns standalone when LETTA_DESKTOP_MODE is '0'", () => {
      process.env[LETTA_DESKTOP_MODE] = "0";
      expect(getHostMode()).toBe("standalone");
    });

    test("returns desktop when LETTA_DESKTOP_MODE is '1'", () => {
      process.env[LETTA_DESKTOP_MODE] = "1";
      expect(getHostMode()).toBe("desktop");
    });

    test("returns standalone when LETTA_DESKTOP_MODE is 'true'", () => {
      process.env[LETTA_DESKTOP_MODE] = "true";
      expect(getHostMode()).toBe("standalone");
    });
  });

  describe("getDesktopVersion", () => {
    const OLD_DESKTOP_VERSION = process.env[LETTA_CODE_DESKTOP_VERSION];

    afterEach(() => {
      if (OLD_DESKTOP_VERSION !== undefined) {
        process.env[LETTA_CODE_DESKTOP_VERSION] = OLD_DESKTOP_VERSION;
      } else {
        delete process.env[LETTA_CODE_DESKTOP_VERSION];
      }
    });

    test("returns null when variable is not set", () => {
      delete process.env[LETTA_CODE_DESKTOP_VERSION];
      expect(getDesktopVersion()).toBeNull();
    });

    test("returns null when variable is empty", () => {
      process.env[LETTA_CODE_DESKTOP_VERSION] = "";
      expect(getDesktopVersion()).toBeNull();
    });

    test("returns the version string when set", () => {
      process.env[LETTA_CODE_DESKTOP_VERSION] = "0.15.0";
      expect(getDesktopVersion()).toBe("0.15.0");
    });

    test("returns the version string with prerelease when set", () => {
      process.env[LETTA_CODE_DESKTOP_VERSION] = "0.15.0-beta.1";
      expect(getDesktopVersion()).toBe("0.15.0-beta.1");
    });

    test("returns the version string with build metadata when set", () => {
      process.env[LETTA_CODE_DESKTOP_VERSION] = "0.15.0+build.123";
      expect(getDesktopVersion()).toBe("0.15.0+build.123");
    });
  });

  describe("getHostEvidence", () => {
    const OLD_DESKTOP_MODE = process.env[LETTA_DESKTOP_MODE];
    const OLD_DESKTOP_VERSION = process.env[LETTA_CODE_DESKTOP_VERSION];

    afterEach(() => {
      __testResetRuntimeVersion();
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
    });

    test("uses overrides when provided", () => {
      const evidence = getHostEvidence({
        cliVersionOverride: "0.29.0",
        desktopVersionOverride: "0.15.0",
      });
      expect(evidence).toEqual({
        cliVersion: "0.29.0",
        desktopVersion: "0.15.0",
      });
    });

    test("uses overrides with null desktop when not provided", () => {
      const evidence = getHostEvidence({
        cliVersionOverride: "0.29.0",
        desktopVersionOverride: null,
      });
      expect(evidence).toEqual({ cliVersion: "0.29.0", desktopVersion: null });
    });
  });

  describe("checkEngineCompatibility", () => {
    describe("no engines declared", () => {
      test("returns compatible for manifest without engines", () => {
        const manifest = createManifest();
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
        expect(result.diagnostics).toHaveLength(0);
      });

      test("returns compatible for manifest with empty engines object", () => {
        const manifest = createManifest({});
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
        expect(result.diagnostics).toHaveLength(0);
      });
    });

    describe("undeclared engine regression", () => {
      test("returns compatible when CLI range not declared but Desktop range is", () => {
        const manifest = createManifest({ lettaCodeDesktop: ">=0.12.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
      });
    });

    describe("standalone CLI mode", () => {
      test("returns compatible when CLI version satisfies range", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
      });

      test("returns incompatible when CLI version is below range", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
        expect(result.diagnostics[0]?.actualVersion).toBe("0.27.0");
        expect(result.diagnostics[0]?.requiredRange).toBe(">=0.28.0");
      });

      test("returns incompatible when CLI version is above range", () => {
        const manifest = createManifest({ lettaCodeCli: "<1.0.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "1.0.0", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
      });

      test("ignores Desktop-only key when both keys declared", () => {
        const manifest = createManifest({
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0 <0.20.0",
        });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
      });

      test("ignores Desktop-only engine when declared alone in standalone mode", () => {
        const manifest = createManifest({ lettaCodeDesktop: ">=0.12.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
      });

      test("returns incompatible when CLI version is null", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: null, desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.actualVersion).toBeNull();
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
      });

      test("returns incompatible when CLI version is invalid semver", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "not-a-version", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.actualVersion).toBe("not-a-version");
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
      });

      test("CLI version boundary: lower boundary", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.8" });
        expect(
          checkEngineCompatibility({
            evidence: { cliVersion: "0.28.7", desktopVersion: null },
            hostMode: "standalone",
            manifest,
            packageName: "@caren/test",
            packageVersion: "1.0.0",
          }).compatible,
        ).toBe(false);
        expect(
          checkEngineCompatibility({
            evidence: { cliVersion: "0.28.8", desktopVersion: null },
            hostMode: "standalone",
            manifest,
            packageName: "@caren/test",
            packageVersion: "1.0.0",
          }).compatible,
        ).toBe(true);
        expect(
          checkEngineCompatibility({
            evidence: { cliVersion: "0.28.9", desktopVersion: null },
            hostMode: "standalone",
            manifest,
            packageName: "@caren/test",
            packageVersion: "1.0.0",
          }).compatible,
        ).toBe(true);
      });

      test("CLI version boundary: upper boundary", () => {
        const manifest = createManifest({ lettaCodeCli: "<1.0.0" });
        expect(
          checkEngineCompatibility({
            evidence: { cliVersion: "0.28.8", desktopVersion: null },
            hostMode: "standalone",
            manifest,
            packageName: "@caren/test",
            packageVersion: "1.0.0",
          }).compatible,
        ).toBe(true);
        expect(
          checkEngineCompatibility({
            evidence: { cliVersion: "1.0.0", desktopVersion: null },
            hostMode: "standalone",
            manifest,
            packageName: "@caren/test",
            packageVersion: "1.0.0",
          }).compatible,
        ).toBe(false);
      });
    });

    describe("desktop mode", () => {
      test("returns compatible when both versions satisfy ranges", () => {
        const manifest = createManifest({
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0",
        });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: "0.15.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(true);
      });

      test("returns incompatible when CLI version fails in desktop mode", () => {
        const manifest = createManifest({
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0",
        });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: "0.15.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
      });

      test("returns incompatible when Desktop version fails in desktop mode", () => {
        const manifest = createManifest({
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0",
        });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: "0.11.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeDesktop");
      });

      test("returns incompatible when both versions fail in desktop mode", () => {
        const manifest = createManifest({
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0",
        });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: "0.11.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics.map((d) => d.engine)).toContain(
          "lettaCodeCli",
        );
        expect(result.diagnostics.map((d) => d.engine)).toContain(
          "lettaCodeDesktop",
        );
      });

      test("desktop mode: Desktop-only engine declared alone", () => {
        const manifest = createManifest({ lettaCodeDesktop: ">=0.12.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: "0.11.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeDesktop");
      });

      test("desktop mode: CLI-only engine declared alone", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: "0.15.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
      });

      test("desktop mode: missing Desktop version when range is declared", () => {
        const manifest = createManifest({ lettaCodeDesktop: ">=0.12.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeDesktop");
        expect(result.diagnostics[0]?.actualVersion).toBeNull();
      });

      test("desktop mode: invalid Desktop version when range is declared", () => {
        const manifest = createManifest({ lettaCodeDesktop: ">=0.12.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: "not-a-version" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeDesktop");
        expect(result.diagnostics[0]?.actualVersion).toBe("not-a-version");
      });

      test("desktop mode: both keys declared, only CLI fails", () => {
        const manifest = createManifest({
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0",
        });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: "0.15.0" },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(false);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]?.engine).toBe("lettaCodeCli");
      });
    });

    test("evaluates OR, prerelease, wildcard, and nmem ranges", () => {
      const cases: Array<[string, string, boolean]> = [
        ["0.29.3", "^0.28.0 || ^0.29.0", true],
        ["0.30.0", "^0.28.0 || ^0.29.0", false],
        ["0.29.0-beta.1", ">=0.29.0-beta.1 <0.29.0", true],
        ["0.28.8", "0.28.x", true],
        ["0.29.0", ">=0.28.8 <1.0.0", true],
        ["1.0.0", ">=0.28.8 <1.0.0", false],
      ];

      for (const [cliVersion, requiredRange, compatible] of cases) {
        const result = checkEngineCompatibility({
          evidence: { cliVersion, desktopVersion: null },
          hostMode: "standalone",
          manifest: createManifest({ lettaCodeCli: requiredRange }),
          packageName: "@signo/nmem-statusline",
          packageVersion: "1.0.0",
        });
        expect(result.compatible).toBe(compatible);
      }
    });

    describe("diagnostic messages", () => {
      test("includes package name, version, engine, and range in diagnostic", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.27.0", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@signo/nmem",
          packageVersion: "1.0.0",
        });
        expect(result.diagnostics[0]?.packageName).toBe("@signo/nmem");
        expect(result.diagnostics[0]?.packageVersion).toBe("1.0.0");
        expect(result.diagnostics[0]?.requiredRange).toBe(">=0.28.0");
        expect(result.diagnostics[0]?.actualVersion).toBe("0.27.0");
      });

      test("missing version diagnostic mentions the engine name", () => {
        const manifest = createManifest({ lettaCodeDesktop: ">=0.12.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "0.28.8", desktopVersion: null },
          hostMode: "desktop",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.diagnostics[0]?.message).toContain("Letta Code Desktop");
      });

      test("invalid version diagnostic includes the invalid value", () => {
        const manifest = createManifest({ lettaCodeCli: ">=0.28.0" });
        const result = checkEngineCompatibility({
          evidence: { cliVersion: "invalid", desktopVersion: null },
          hostMode: "standalone",
          manifest,
          packageName: "@caren/test",
          packageVersion: "1.0.0",
        });
        expect(result.diagnostics[0]?.message).toContain("invalid");
      });
    });
  });
});
