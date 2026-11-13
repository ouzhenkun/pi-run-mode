import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveProjectKey(cwd: string): string {
  let key = resolve(cwd);
  try {
    key = realpathSync(key);
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: key,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
        GIT_INDEX_FILE: undefined,
      },
    }).trim();
    const gitDir = realpathSync(resolve(key, commonDir));
    // Submodules and separate Git dirs do not live under the project root.
    if (gitDir.endsWith("/.git")) return dirname(gitDir);
    return gitDir;
  } catch {
    return key;
  }
}
