import { readFileSync } from "node:fs";
import * as semver from "semver";
import type {
  LettaPackageEngines,
  LettaPackageManifest,
  LettaPackageManifestParseResult,
} from "@/mods/package-manifest";
import { readLettaPackageManifest } from "@/mods/package-manifest";
import { getVersion } from "@/version.ts";

/**
 * Environment variable that must be set to "1" for Desktop-hosted CLI mode.
 */
export const LETTA_DESKTOP_MODE = "LETTA_DESKTOP_MODE";

/**
 * Environment variable supplying the explicit Desktop host version.
 * Only used when LETTA_DESKTOP_MODE is set to "1".
 */
export const LETTA_CODE_DESKTOP_VERSION = "LETTA_CODE_DESKTOP_VERSION";

/**
 * Host mode determines which engine keys are applicable.
 * In standalone CLI, only lettaCodeCli is checked.
 * In Desktop-hosted CLI, both lettaCodeCli and lettaCodeDesktop are checked.
 */
export type HostMode = "standalone" | "desktop";

/**
 * Evidence for a host version. The CLI version is always available.
 * Desktop version is only available when running in Desktop mode.
 */
export interface HostEvidence {
  cliVersion: string | null;
  desktopVersion: string | null;
}

/**
 * Result of checking engine compatibility.
 */
export interface EngineCompatibilityResult {
  compatible: boolean;
  diagnostics: EngineCompatibilityDiagnostic[];
}

/**
 * Diagnostic describing a single engine incompatibility.
 */
export interface EngineCompatibilityDiagnostic {
  engine: keyof LettaPackageEngines;
  message: string;
  packageName: string;
  packageVersion: string;
  requiredRange: string;
  /** Actual version found, or null if missing/invalid */
  actualVersion: string | null;
}

/**
 * Options for checking engine compatibility.
 */
export interface CheckEngineCompatibilityOptions {
  evidence: HostEvidence;
  hostMode: HostMode;
  manifest: LettaPackageManifest;
  packageName: string;
  packageVersion: string;
}

export function readCompatibleManifest(
  packageJsonPath: string,
  registryIdentity?: { source: string; version: string },
): LettaPackageManifestParseResult {
  const parsed = readLettaPackageManifest(packageJsonPath);
  if (!parsed.ok || !parsed.manifest?.engines) return parsed;

  let identity: { name?: unknown; version?: unknown } = {};
  try {
    identity = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    return {
      errors: [
        {
          message: error instanceof Error ? error.message : String(error),
          path: packageJsonPath,
        },
      ],
      manifest: null,
      ok: false,
    };
  }
  const result = checkEngineCompatibility({
    evidence: getHostEvidence(),
    hostMode: getHostMode(),
    manifest: parsed.manifest,
    packageName:
      registryIdentity?.source ??
      (typeof identity.name === "string" ? identity.name : packageJsonPath),
    packageVersion:
      registryIdentity?.version ??
      (typeof identity.version === "string" ? identity.version : "unknown"),
  });
  if (result.compatible) return parsed;
  return {
    errors: result.diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      path: `letta.engines.${diagnostic.engine}`,
    })),
    manifest: null,
    ok: false,
  };
}

/**
 * Checks whether a package's engine requirements are compatible with the host.
 *
 * Behavior matrix:
 * | Host mode     | Engine key          | Check condition                    |
 * |---------------|---------------------|------------------------------------|
 * | standalone    | lettaCodeCli only   | Checked if declared                |
 * | standalone    | lettaCodeDesktop    | Not applicable (Desktop-only key)  |
 * | desktop       | lettaCodeCli only   | Checked if declared                |
 * | desktop       | lettaCodeDesktop    | Checked if declared                |
 * | both          | both keys           | Both must satisfy their ranges     |
 *
 * A missing or invalid host version is incompatible only when its applicable
 * range is explicitly declared.
 */
export function checkEngineCompatibility(
  options: CheckEngineCompatibilityOptions,
): EngineCompatibilityResult {
  const { evidence, hostMode, manifest, packageName, packageVersion } = options;
  const diagnostics: EngineCompatibilityDiagnostic[] = [];

  if (!manifest.engines) {
    return { compatible: true, diagnostics: [] };
  }

  const { engines } = manifest;

  // Check CLI engine (applicable in both modes if declared)
  if (engines.lettaCodeCli !== undefined) {
    const cliResult = checkEngineKey({
      engineKey: "lettaCodeCli",
      evidenceVersion: evidence.cliVersion,
      packageName,
      packageVersion,
      requiredRange: engines.lettaCodeCli,
    });
    if (cliResult.diagnostic) {
      diagnostics.push(cliResult.diagnostic);
    }
  }

  // Check Desktop engine (only applicable in desktop mode)
  if (hostMode === "desktop" && engines.lettaCodeDesktop !== undefined) {
    const desktopResult = checkEngineKey({
      engineKey: "lettaCodeDesktop",
      evidenceVersion: evidence.desktopVersion,
      packageName,
      packageVersion,
      requiredRange: engines.lettaCodeDesktop,
    });
    if (desktopResult.diagnostic) {
      diagnostics.push(desktopResult.diagnostic);
    }
  }

  return {
    compatible: diagnostics.length === 0,
    diagnostics,
  };
}

interface CheckEngineKeyParams {
  engineKey: keyof LettaPackageEngines;
  evidenceVersion: string | null;
  packageName: string;
  packageVersion: string;
  requiredRange: string;
}

interface CheckEngineKeyResult {
  compatible: boolean;
  diagnostic?: EngineCompatibilityDiagnostic;
}

function checkEngineKey(params: CheckEngineKeyParams): CheckEngineKeyResult {
  const {
    engineKey,
    evidenceVersion,
    packageName,
    packageVersion,
    requiredRange,
  } = params;

  // Missing or invalid version is incompatible only when range is declared
  if (evidenceVersion === null) {
    return {
      compatible: false,
      diagnostic: {
        engine: engineKey,
        message: buildMissingVersionMessage(
          engineKey,
          packageName,
          requiredRange,
        ),
        packageName,
        packageVersion,
        requiredRange,
        actualVersion: null,
      },
    };
  }

  // Validate that the evidence version is a valid semver
  const parsedVersion = semver.parse(evidenceVersion);
  if (parsedVersion === null) {
    return {
      compatible: false,
      diagnostic: {
        engine: engineKey,
        message: buildInvalidVersionMessage(
          engineKey,
          packageName,
          evidenceVersion,
          requiredRange,
        ),
        packageName,
        packageVersion,
        requiredRange,
        actualVersion: evidenceVersion,
      },
    };
  }

  // Validate that the required range is a valid semver range
  const validRange = semver.validRange(requiredRange);
  if (validRange === null) {
    // This should not happen if validation passed during manifest parsing,
    // but handle it defensively
    return {
      compatible: false,
      diagnostic: {
        engine: engineKey,
        message: `Package '${packageName}' declares an invalid engine range '${requiredRange}' for '${engineKey}'. This is a package manifest error.`,
        packageName,
        packageVersion,
        requiredRange,
        actualVersion: evidenceVersion,
      },
    };
  }

  // Check if the version satisfies the range
  const satisfies = semver.satisfies(parsedVersion, validRange);
  if (!satisfies) {
    return {
      compatible: false,
      diagnostic: {
        engine: engineKey,
        message: buildIncompatibleVersionMessage(
          engineKey,
          packageName,
          packageVersion,
          evidenceVersion,
          requiredRange,
        ),
        packageName,
        packageVersion,
        requiredRange,
        actualVersion: evidenceVersion,
      },
    };
  }

  return { compatible: true };
}

function buildMissingVersionMessage(
  engineKey: keyof LettaPackageEngines,
  packageName: string,
  requiredRange: string,
): string {
  const engineName =
    engineKey === "lettaCodeCli" ? "Letta Code CLI" : "Letta Code Desktop";
  const evidenceRemediation =
    engineKey === "lettaCodeDesktop"
      ? ` Ensure ${LETTA_CODE_DESKTOP_VERSION} is supplied by the Desktop host.`
      : "";
  return (
    `Package '${packageName}' requires ${engineName} version '${requiredRange}', ` +
    `but the ${engineName} version could not be determined. ` +
    `Upgrade Letta Code or the Letta Code Desktop app to a version that satisfies this range.` +
    evidenceRemediation
  );
}

function buildInvalidVersionMessage(
  engineKey: keyof LettaPackageEngines,
  packageName: string,
  actualVersion: string,
  requiredRange: string,
): string {
  const engineName =
    engineKey === "lettaCodeCli" ? "Letta Code CLI" : "Letta Code Desktop";
  return (
    `Package '${packageName}' requires ${engineName} version '${requiredRange}', ` +
    `but the detected ${engineName} version '${actualVersion}' is not a valid semver. ` +
    `Upgrade Letta Code or the Letta Code Desktop app to a version that satisfies this range.`
  );
}

function buildIncompatibleVersionMessage(
  engineKey: keyof LettaPackageEngines,
  packageName: string,
  packageVersion: string,
  actualVersion: string,
  requiredRange: string,
): string {
  const engineName =
    engineKey === "lettaCodeCli" ? "Letta Code CLI" : "Letta Code Desktop";
  return (
    `Package '${packageName}'@${packageVersion} requires ${engineName} version '${requiredRange}', ` +
    `but the current ${engineName} version is '${actualVersion}'. ` +
    `Upgrade Letta Code or the Letta Code Desktop app to a version that satisfies this range.`
  );
}

/**
 * Gets the current host mode based on environment variables.
 * In standalone CLI: LETTA_DESKTOP_MODE is not set
 * In Desktop-hosted CLI: LETTA_DESKTOP_MODE is exactly "1"
 */
export function getHostMode(): HostMode {
  const desktopMode = process.env[LETTA_DESKTOP_MODE];
  return desktopMode === "1" ? "desktop" : "standalone";
}

/**
 * Gets host evidence for engine compatibility checks.
 *
 * CLI version: Always derived from the native package version (package.json)
 * Desktop version: Only available when running in Desktop mode via LETTA_CODE_DESKTOP_VERSION
 *
 * This function is designed to be testable via environment variable override.
 */
export function getHostEvidence(params?: {
  cliVersionOverride?: string | null;
  desktopVersionOverride?: string | null;
}): HostEvidence {
  const cliVersion =
    params?.cliVersionOverride !== undefined
      ? params.cliVersionOverride
      : getCliVersion();
  const desktopVersion =
    params?.desktopVersionOverride !== undefined
      ? params.desktopVersionOverride
      : getHostMode() === "desktop"
        ? getDesktopVersion()
        : null;
  return { cliVersion, desktopVersion };
}

/**
 * Gets the CLI version from the package.json version.
 * This is the native package version, not affected by desktop mode.
 */
export function getCliVersion(): string | null {
  return runtimeCliVersionOverride !== undefined
    ? runtimeCliVersionOverride
    : getVersion();
}

/**
 * Gets the Desktop version from the LETTA_CODE_DESKTOP_VERSION environment variable.
 * Returns null if the variable is not set.
 */
export function getDesktopVersion(): string | null {
  const version = process.env[LETTA_CODE_DESKTOP_VERSION];
  if (!version) {
    return null;
  }
  return version;
}

let runtimeCliVersionOverride: string | null | undefined;

/**
 * Resets the cached runtime CLI version (for testing).
 */
export function __testResetRuntimeVersion(): void {
  runtimeCliVersionOverride = undefined;
}

/**
 * Sets a specific runtime CLI version (for testing).
 */
export function __testSetRuntimeVersion(version: string | null): void {
  runtimeCliVersionOverride = version;
}
