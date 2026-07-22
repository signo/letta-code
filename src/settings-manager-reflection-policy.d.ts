import type { ExplicitReflectionPolicy } from "@/mods/backend-reflection-policy-types";

declare module "@/settings-manager" {
  interface Settings {
    reflectionPolicies?: Record<string, ExplicitReflectionPolicy>;
  }
}
