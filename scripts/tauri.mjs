import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  appendBuildConfig,
  buildOutputDirectory,
  buildRoots,
  cargoConfigFiles,
  createBuildEnvironment,
  createPathMappings,
  parseBuildArguments,
  readBuildMetadata,
  redactBuildPaths,
  verifyBuildFiles,
  windowsShortPaths,
} from "./build-paths.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const cliPath = require.resolve("@tauri-apps/cli/tauri.js");
let diagnosticMappings = [];

/** Runs the official CLI with its arguments and exit status intact. */
async function runTauri(args, env, mappings) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    env,
    stdio: mappings ? ["inherit", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (mappings) {
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) =>
        output.write(`${redactBuildPaths(line, mappings)}\n`),
      );
    }
  }
  const forwardSignal = (signal) => child.kill(signal);
  const interrupt = () => forwardSignal("SIGINT");
  const terminate = () => forwardSignal("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve(code ?? 128 + (os.constants.signals[signal] ?? 1)),
      );
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/** Rejects stale or missing NSIS evidence when this invocation generated that installer. */
async function verifyNsisBuild(
  outputDirectory,
  build,
  config,
  startedAt,
  verifyWindowsInstallerLicenses,
) {
  const bundles = build.bundles ?? config.bundle.targets;
  const needsNsis =
    !build.noBundle && config.bundle.active && (bundles === "all" || bundles.includes("nsis"));
  if (!build.buildTarget.endsWith("-windows-msvc") || !needsNsis) return;
  const nsisDirectory = path.join(outputDirectory, "nsis");
  const scripts = existsSync(nsisDirectory)
    ? readdirSync(nsisDirectory)
        .map((architecture) => path.join(nsisDirectory, architecture, "installer.nsi"))
        .filter((file) => existsSync(file) && statSync(file).mtimeMs >= startedAt)
    : [];
  if (scripts.length !== 1)
    throw new Error("Cannot verify the NSIS toolchain from this build's installer script.");
  await verifyWindowsInstallerLicenses({ projectRoot, nsisScriptPath: scripts[0] });
}

/** Builds notice resources, applies compiler mappings, and validates distributable inputs. */
async function main() {
  const args = process.argv.slice(2);
  if (!parseBuildArguments(args, "")) return runTauri(args, process.env);
  diagnosticMappings = createPathMappings(
    buildRoots(projectRoot, path.join(projectRoot, "src-tauri", "target")),
  );

  // 1. Resolve the actual toolchain, Cargo output, and private path aliases.
  const host = readBuildMetadata("rustc", ["-vV"], projectRoot).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error("rustc did not report its host target.");
  const build = parseBuildArguments(args, host);
  const metadata = JSON.parse(
    readBuildMetadata(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--no-deps",
        "--format-version",
        "1",
        "--locked",
        "--offline",
      ],
      projectRoot,
    ),
  );
  const targetDirectory = metadata.target_directory;
  mkdirSync(targetDirectory, { recursive: true });
  const roots = buildRoots(projectRoot, targetDirectory);
  let mappings = createPathMappings(roots);
  if (process.platform === "win32") {
    const existingRoots = roots.filter((root) => existsSync(root.source));
    const aliases = windowsShortPaths(existingRoots.map((root) => root.source));
    existingRoots.forEach((root, index) => root.aliases.push(aliases[index]));
    mappings = createPathMappings(roots);
  }
  diagnosticMappings = mappings;
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  const env = createBuildEnvironment({
    env: process.env,
    mappings,
    targets: build.targets,
    configFiles: cargoConfigFiles(projectRoot, cargoHome),
  });

  // 2. Generate audited license resources before invoking the unchanged official CLI.
  const { generateThirdPartyNotices, verifyWindowsInstallerLicenses } =
    await import("./generate-third-party-notices.mjs");
  const { configPath, resourceDirectory } = await generateThirdPartyNotices({
    projectRoot,
    targets: build.targets,
  });
  const configuredArgs = appendBuildConfig(args, build.optionsEnd, configPath);
  const startedAt = Date.now();
  const code = await runTauri(configuredArgs, env, mappings);
  if (code !== 0) return code;

  // 3. Check the built executable and every bundled notice/help resource before upload.
  const config = JSON.parse(
    readFileSync(path.join(projectRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const application = metadata.packages.find(
    (entry) =>
      path.resolve(entry.manifest_path) === path.join(projectRoot, "src-tauri", "Cargo.toml"),
  );
  const binaryName =
    config.mainBinaryName ??
    application.targets.find((target) => target.kind.includes("bin"))?.name;
  if (!binaryName) throw new Error("Cargo metadata did not identify the application executable.");
  const outputDirectory = buildOutputDirectory(targetDirectory, build);
  const executable = path.join(
    outputDirectory,
    `${binaryName}${build.buildTarget.includes("windows") ? ".exe" : ""}`,
  );
  const resources = Object.keys(config.bundle.resources).map((resource) =>
    path.resolve(projectRoot, "src-tauri", resource),
  );
  const count = verifyBuildFiles([executable, resourceDirectory, ...resources], mappings);
  await verifyNsisBuild(outputDirectory, build, config, startedAt, verifyWindowsInstallerLicenses);
  console.log(
    `Build path privacy check passed (${count} files; UTF-8 and both UTF-16 alignments).`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(redactBuildPaths(error.message, diagnosticMappings));
    process.exitCode = 1;
  });
