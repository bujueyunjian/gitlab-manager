import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";

// Inspect exactly the files Git can publish, including newly added untracked source files.
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".toml",
  ".md",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".svg",
  ".rs",
  ".lock",
]);
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitLab access token", /glpat-[A-Za-z0-9_-]{20,}/],
  ["GitHub access token", /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["personal absolute path", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ["credential in URL", /https?:\/\/[^\s/]+:[^\s/]+@/],
];
const errors = [];
for (const file of files) {
  if (
    /(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:db|sqlite)(?:-\w+)?)$/.test(file) &&
    basename(file) !== ".env.example"
  ) {
    errors.push(`${file}: runtime or secret file must not be published`);
    continue;
  }
  if (
    !textExtensions.has(extname(file)) &&
    !["LICENSE", ".gitignore", ".nvmrc"].includes(basename(file))
  )
    continue;
  const text = readFileSync(file, "utf8");
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) errors.push(`${file}: ${label}`);
  }
}
if (errors.length) {
  // Report only file names and rule names; never echo a matched secret.
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Privacy check passed for ${files.length} publishable files.`);
