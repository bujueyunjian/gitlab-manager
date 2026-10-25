import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { extname, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  ".xml",
  ".iml",
  ".txt",
]);
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitLab access token", /glpat-[A-Za-z0-9_-]{20,}/],
  ["GitHub access token", /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["personal absolute path", /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
  ["Windows user path", /\b[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'<>]+/i],
  ["credential in URL", /https?:\/\/[^\s/]+:[^\s/]+@/],
];
/** Decode JSON Unicode and XML numeric escapes before applying the same text rules. */
function decodedText(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#(?:x([a-f\d]{1,6})|(\d{1,7}));/gi, (entity, hex, decimal) => {
      const point = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/\\u([a-f\d]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Return rule names only; neither matched text nor credentials enter diagnostics. */
export function privacyIssues(file, text) {
  if (/(?:^|\/)\.idea(?:\/|$)/.test(file)) return ["IDE metadata must not be published"];
  if (
    /(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:db|sqlite)(?:-\w+)?)$/.test(file) &&
    basename(file) !== ".env.example"
  ) {
    return ["runtime or secret file must not be published"];
  }
  const decoded = decodedText(text);
  return rules.filter(([, pattern]) => pattern.test(decoded)).map(([label]) => label);
}

/** Restrict content reads to supported text formats; filename policies apply to every file. */
function isTextFile(file) {
  return (
    textExtensions.has(extname(file).toLowerCase()) ||
    ["LICENSE", ".gitignore", ".nvmrc", ".env.example"].includes(basename(file))
  );
}

/** Read the exact staged blobs in one Git process, independent of working-tree presence or edits. */
function indexContents(root, entries) {
  const ids = [
    ...new Set(entries.filter((entry) => isTextFile(entry.file)).map((entry) => entry.id)),
  ];
  if (!ids.length) return new Map();
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: ids.join("\n") + "\n",
    maxBuffer: 64 * 1024 * 1024,
  });
  const contents = new Map();
  let offset = 0;
  for (const id of ids) {
    const end = output.indexOf(10, offset);
    const [returned, kind, length] = output.subarray(offset, end).toString("ascii").split(" ");
    if (end < 0 || returned !== id || kind !== "blob" || !/^\d+$/.test(length)) {
      throw new Error("Unable to read staged blob");
    }
    const size = Number(length);
    const start = end + 1;
    if (start + size >= output.length || output[start + size] !== 10) {
      throw new Error("Incomplete staged blob");
    }
    contents.set(id, output.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  return contents;
}

/** Check index snapshots and current tracked/unignored files without scanning history or image pixels. */
export function scanRepository(root = process.cwd()) {
  // 1. Retain staged content even when a working file was cleaned or deleted afterwards.
  const entries = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\t");
      const [mode, id] = entry.slice(0, separator).split(" ");
      return { file: entry.slice(separator + 1), mode, id };
    })
    .filter((entry) => entry.mode !== "160000");
  const blobs = indexContents(root, entries);
  const errors = [];
  const diagnose = (file, text, snapshot) => {
    for (const label of privacyIssues(file, text)) {
      errors.push(`${JSON.stringify(file)} (${snapshot}): ${label}`);
    }
  };
  for (const entry of entries) {
    if (!isTextFile(entry.file)) {
      diagnose(entry.file, "", "index");
      continue;
    }
    const content = blobs.get(entry.id);
    if (content === undefined) throw new Error("Missing staged content");
    diagnose(entry.file, content, "index");
  }

  // 2. Git ignores apply to untracked files, while tracked IDE metadata remains forbidden.
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const filenameIssues = privacyIssues(file, "");
    if (filenameIssues.length) {
      diagnose(file, "", "working tree");
      continue;
    }
    const absolute = resolve(root, file);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat || !isTextFile(file)) continue;
    if (stat.isSymbolicLink()) diagnose(file, readlinkSync(absolute), "working tree");
    else if (stat.isFile()) diagnose(file, readFileSync(absolute, "utf8"), "working tree");
  }
  return { files: new Set([...entries.map((entry) => entry.file), ...files]).size, errors };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // 3. A Git or filesystem failure is an explicit failed check, never an empty successful scan.
  try {
    const result = scanRepository();
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else
      console.log(
        `Privacy check passed for ${result.files} publishable files (index and working tree).`,
      );
  } catch {
    console.error("Privacy check could not inspect Git snapshots or source files.");
    process.exitCode = 1;
  }
}
