import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { privacyIssues, scanRepository } from "./check-privacy.mjs";

const script = fileURLToPath(new URL("./check-privacy.mjs", import.meta.url));
const sourceRoot = resolve(dirname(script), "..");
const tempRoot = realpathSync(tmpdir());
const fixtures = [];

/** Allow fixture Git operations and recursive cleanup only in a new direct child of the OS temp folder. */
function verifyFixture(root) {
  const absolute = realpathSync(root);
  assert.equal(dirname(absolute), tempRoot);
  assert.ok(relative(tempRoot, absolute).startsWith("gitlab-manager-privacy-"));
  assert.notEqual(absolute, realpathSync(sourceRoot));
  assert.notEqual(absolute, realpathSync(homedir()));
  assert.ok(!absolute.startsWith(sourceRoot + sep));
  assert.ok(!sourceRoot.startsWith(absolute + sep));
}

/** Remove inherited Git redirections and isolate the fixture from user or system Git settings. */
function fixtureEnvironment(root) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-git-config") };
}

/** Run Git only against the verified disposable repository; the source repository index is untouched. */
function git(root, ...args) {
  verifyFixture(root);
  return execFileSync("git", ["-C", root, ...args], {
    cwd: root,
    env: fixtureEnvironment(root),
    encoding: "utf8",
  });
}

/** Create one isolated repository containing only fictional files and an empty local config source. */
function repository() {
  const root = mkdtempSync(join(tempRoot, "gitlab-manager-privacy-"));
  fixtures.push(root);
  verifyFixture(root);
  writeFileSync(join(root, "empty-git-config"), "");
  git(root, "init", "-q");
  assert.equal(realpathSync(git(root, "rev-parse", "--show-toplevel").trim()), realpathSync(root));
  return root;
}

/** Scan the fixture in a subprocess so its isolated Git settings also apply to CLI behavior. */
function scan(root) {
  verifyFixture(root);
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: fixtureEnvironment(root),
    encoding: "utf8",
  });
}

/** Write a fixture file while preserving its explicit repository-relative name. */
function write(root, file, content) {
  verifyFixture(root);
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

after(() => {
  for (const root of fixtures) {
    verifyFixture(root);
    rmSync(root, { recursive: true });
  }
});

test("recognizes Windows path separators and JSON/XML escapes without leaking samples", () => {
  const direct = ["C:", "Users", "Fictional User", "workspace"].join("\\");
  const paths = [
    direct,
    direct.replaceAll("\\", "/"),
    JSON.stringify(direct),
    direct.replaceAll("\\", "\\u" + "005c"),
    direct.replaceAll("\\", "&#" + "92;"),
    direct.replaceAll("\\", "&#x" + "5c;"),
    direct.replaceAll("\\", "&amp;#" + "92;"),
    direct.replace(":", "\\u" + "003a"),
  ];
  for (const file of ["settings.xml", "module.iml", "config.json", "notes.md"]) {
    for (const path of paths) assert.ok(privacyIssues(file, path).includes("Windows user path"));
  }
  for (const path of [
    "C:/workspace/example",
    "%USERPROFILE%/workspace",
    "https://gitlab.example.com/demo",
    "/usr/local/example",
  ]) {
    assert.deepEqual(privacyIssues("config.xml", path), []);
  }
});

test("retains token, private key, URL credential, Unix path and runtime file checks", () => {
  const examples = [
    ["GitLab access token", "gl" + "pat-" + "x".repeat(24)],
    ["GitHub access token", "gh" + "p_" + "x".repeat(32)],
    ["private key", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
    ["credential in URL", "https://" + "fictional:password@" + "example.com"],
    ["personal absolute path", ["", "home", "fictional", "workspace"].join("/")],
  ];
  for (const [label, text] of examples)
    assert.ok(privacyIssues("example.xml", text).includes(label));
  for (const file of [".env", "state.sqlite", "state.db-wal"]) {
    assert.ok(privacyIssues(file, "").includes("runtime or secret file must not be published"));
  }
  assert.deepEqual(privacyIssues(".env.example", "EXAMPLE=true"), []);
});

test("checks staged content even after the working file was cleaned or removed", () => {
  const root = repository();
  const secret = "gl" + "pat-" + "x".repeat(24);
  write(root, "example.xml", secret);
  git(root, "add", "example.xml");
  write(root, "example.xml", "safe fictional example");
  let result = scan(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /index.*GitLab access token/);
  assert.ok(!result.stderr.includes(secret));
  unlinkSync(join(root, "example.xml"));
  result = scan(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /index.*GitLab access token/);
  assert.ok(!result.stderr.includes(secret));
});

test("checks unstaged and untracked content while respecting ignore and rejecting staged IDE files", () => {
  const root = repository();
  write(root, ".gitignore", ".idea/\nignored/\n");
  write(root, "config.json", "safe");
  git(root, "add", ".gitignore", "config.json");
  const personal = ["D:", "Users", "fictional", "config"].join("/");
  write(root, "config.json", personal);
  write(root, "new.iml", personal);
  write(root, ".idea/workspace.xml", personal);
  write(root, "ignored/state.xml", personal);
  let result = scan(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config\.json.*working tree.*Windows user path/);
  assert.match(result.stderr, /new\.iml.*working tree.*Windows user path/);
  assert.ok(!result.stderr.includes("ignored/state.xml"));
  assert.ok(!result.stderr.includes(".idea/workspace.xml"));
  git(root, "add", "-f", ".idea/workspace.xml");
  result = scan(root);
  assert.match(result.stderr, /\.idea\/workspace\.xml.*index.*IDE metadata/);
  assert.ok(!result.stderr.includes(personal));
});

test("staged deletion excludes the removed index blob rather than scanning history", () => {
  const root = repository();
  write(root, "removed.xml", "gl" + "pat-" + "x".repeat(24));
  git(root, "add", "removed.xml");
  git(
    root,
    "-c",
    "user.name=Example Tester",
    "-c",
    "user.email=tester@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Seed fixture",
  );
  assert.equal(scan(root).status, 1);
  git(root, "rm", "-q", "-f", "removed.xml");
  assert.match(git(root, "diff", "--cached", "--name-status"), /^D\s+removed\.xml/);
  const result = scan(root);
  assert.equal(result.status, 0, result.stderr);
});

test("supports large staged text and reports repository inspection failures explicitly", () => {
  const root = repository();
  write(root, "manual.html", "fictional ".repeat(150000));
  git(root, "add", "manual.html");
  assert.equal(scan(root).status, 0);
  assert.throws(() => scanRepository(join(root, "missing-repository")));
  const plain = mkdtempSync(join(tempRoot, "gitlab-manager-privacy-"));
  fixtures.push(plain);
  verifyFixture(plain);
  writeFileSync(join(plain, "empty-git-config"), "");
  const result = scan(plain);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Privacy check could not inspect Git snapshots or source files/);
});
