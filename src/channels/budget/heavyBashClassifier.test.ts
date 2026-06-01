import { describe, expect, test } from "bun:test";
import { classifyForBudget, isHeavyBashCommand } from "./heavyBashClassifier";

describe("isHeavyBashCommand", () => {
  test("recognizes SSH as heavy", () => {
    expect(isHeavyBashCommand("ssh user@host")).toBe(true);
    expect(isHeavyBashCommand("ssh -i key user@host ls")).toBe(true);
    expect(isHeavyBashCommand("ssh -o StrictHostKeyChecking=no host")).toBe(
      true,
    );
  });

  test("recognizes ffmpeg/ffprobe as heavy", () => {
    expect(isHeavyBashCommand("ffmpeg -i input.mp4 output.avi")).toBe(true);
    expect(isHeavyBashCommand("ffprobe -v error -show_format input.mp4")).toBe(
      true,
    );
    expect(isHeavyBashCommand("/usr/bin/ffmpeg -i in.avi out.mp4")).toBe(true);
  });

  test("recognizes find with multiple args as heavy", () => {
    expect(isHeavyBashCommand("find /home -name '*.log'")).toBe(true);
    expect(isHeavyBashCommand("find . -type f -mtime +7")).toBe(true);
    expect(isHeavyBashCommand("find /usr -perm -4000 2>/dev/null")).toBe(true);
  });

  test("recognizes curl/wget with pipes as heavy", () => {
    expect(isHeavyBashCommand("curl -s https://api.example.com | jq")).toBe(
      true,
    );
    expect(isHeavyBashCommand("wget -q -O - url | grep pattern")).toBe(true);
  });

  test("recognizes nohup as heavy", () => {
    expect(isHeavyBashCommand("nohup ./long-running.sh &")).toBe(true);
    expect(
      isHeavyBashCommand("nohup python server.py > output.log 2>&1 &"),
    ).toBe(true);
  });

  test("recognizes ls -R (recursive) as heavy", () => {
    expect(isHeavyBashCommand("ls -R /home")).toBe(true);
    expect(isHeavyBashCommand("ls -lR .")).toBe(true);
    expect(isHeavyBashCommand("ls -laR ./")).toBe(true);
  });

  test("recognizes recursive glob as heavy", () => {
    expect(isHeavyBashCommand("./dir/**/*.ts")).toBe(true);
    expect(isHeavyBashCommand("rm **/*.backup")).toBe(true);
  });

  test("recognizes top as heavy (but not top -n 1)", () => {
    expect(isHeavyBashCommand("top")).toBe(true);
    expect(isHeavyBashCommand("top -b")).toBe(true);
    expect(isHeavyBashCommand("top -n 1")).toBe(false); // -n 1 = single shot
  });

  test("recognizes background sleep patterns", () => {
    expect(isHeavyBashCommand("sleep 300 &")).toBe(true);
  });

  test("recognizes simple echo/ls as light", () => {
    expect(isHeavyBashCommand("echo hello")).toBe(false);
    expect(isHeavyBashCommand("echo $PATH")).toBe(false);
    expect(isHeavyBashCommand("pwd")).toBe(false);
    expect(isHeavyBashCommand("ls")).toBe(false);
    expect(isHeavyBashCommand("ls -la")).toBe(false);
    expect(isHeavyBashCommand("ls -l")).toBe(false);
    expect(isHeavyBashCommand("date")).toBe(false);
    expect(isHeavyBashCommand("true")).toBe(false);
    expect(isHeavyBashCommand("false")).toBe(false);
    expect(isHeavyBashCommand("type cat")).toBe(false);
    expect(isHeavyBashCommand("which node")).toBe(false);
  });

  test("recognizes single file cat as light", () => {
    expect(isHeavyBashCommand("cat /etc/hosts")).toBe(false);
    expect(isHeavyBashCommand("cat package.json")).toBe(false);
    expect(isHeavyBashCommand("stat file.txt")).toBe(false);
  });

  test("handles empty/null input gracefully", () => {
    expect(isHeavyBashCommand("")).toBe(false);
    expect(isHeavyBashCommand(null as unknown as string)).toBe(false);
    expect(isHeavyBashCommand(undefined as unknown as string)).toBe(false);
  });

  test("is case insensitive", () => {
    expect(isHeavyBashCommand("SSH user@host")).toBe(true);
    expect(isHeavyBashCommand("FFMPEG -i in.avi out.mp4")).toBe(true);
    expect(isHeavyBashCommand("ECHO hello")).toBe(false);
  });
});

describe("classifyForBudget", () => {
  test("classifies heavy bash as heavy", () => {
    expect(classifyForBudget("Bash", { command: "ssh user@host" })).toBe(
      "heavy",
    );
    expect(
      classifyForBudget("bash", { command: "ffmpeg -i in.avi out.mp4" }),
    ).toBe("heavy");
    expect(
      classifyForBudget("shell", { command: "find /home -name '*.txt'" }),
    ).toBe("heavy");
  });

  test("classifies light bash as light", () => {
    expect(classifyForBudget("Bash", { command: "echo hello" })).toBe("light");
    expect(classifyForBudget("bash", { command: "ls -la" })).toBe("light");
    expect(classifyForBudget("bash", { command: "pwd" })).toBe("light");
  });

  test("classifies non-bash tools as light", () => {
    expect(classifyForBudget("Read", { file_path: "/etc/hosts" })).toBe(
      "light",
    );
    expect(classifyForBudget("Write", { content: "test" })).toBe("light");
    expect(
      classifyForBudget("Edit", {
        file_path: "a.ts",
        old_string: "x",
        new_string: "y",
      }),
    ).toBe("light");
    expect(classifyForBudget("Grep", { pattern: "TODO" })).toBe("light");
  });

  test("handles missing command argument gracefully", () => {
    expect(classifyForBudget("Bash")).toBe("light");
    expect(classifyForBudget("Bash", {})).toBe("light");
    expect(classifyForBudget("Bash", { cmd: "ls" })).toBe("light"); // different arg name
  });
});