/**
 * Heavy Bash Command Classifier
 *
 * Classifies bash commands as "heavy" (resource-intensive, potentially blocking)
 * vs "light" (quick, non-blocking). Used to budget resource usage on routed turns.
 */

export function isHeavyBashCommand(command: string): boolean {
  if (!command || typeof command !== "string") {
    return false;
  }

  const lower = command.toLowerCase().trim();

  // Early exit for obviously light commands
  if (
    lower === "pwd" ||
    lower === "echo" ||
    lower === "true" ||
    lower === "false" ||
    lower === "type" ||
    lower === "which" ||
    lower === "date"
  ) {
    return false;
  }

  // Heavy patterns
  const heavyPatterns = [
    // Network fetches with pipes
    /\b(curl|wget|youtube|yt-dlp)\b.*[|>]/i,
    /\bcurl\b.*-o\s+\//i,
    // Filesystem scans
    /\bfind\b(?:\s+[^|]+){2,}/i,
    /\bfind\b.*-name.*\*.*-o/i,
    /\$\(.*find|`.*find/i,
    // Recursive ls (any flags + r)
    /\bls\s+-[a-z]*r/i,
    /\bls\s+--recursive\b/i,
    // Recursive glob patterns like ** or **/*
    /\*\*\/\*/i,
    // Long-running processes
    /\bnohup\b/i,
    /\bcron\b.*;/i,
    // Background sleep (daemon pattern) - sleep with & at end or backgrounded
    /(\bsleep\s+\d+\s*&|&*\s*sleep\s+\d+)/i,
    // Media processing
    /\b(ffmpeg|ffprobe)\b/i,
    // SSH
    /\bssh\b/i,
    // wget recursive
    /\bwget\s+-r\b/i,
    // top (but not top -n 1)
    /\btop\b(?![\s-]*-n\s+1\b)/i,
    // watch commands
    /\bwatch\b/i,
  ];

  for (const pattern of heavyPatterns) {
    if (pattern.test(lower)) {
      return true;
    }
  }

  return false;
}

export function classifyForBudget(
  toolName: string,
  args?: Record<string, unknown>,
): "heavy" | "light" {
  const lower = toolName.toLowerCase();

  if (lower === "bash" || lower === "sh" || lower === "shell") {
    const command =
      typeof args?.command === "string"
        ? args.command
        : typeof args?.cmd === "string"
          ? args.cmd
          : "";

    if (isHeavyBashCommand(command)) {
      return "heavy";
    }
  }

  return "light";
}