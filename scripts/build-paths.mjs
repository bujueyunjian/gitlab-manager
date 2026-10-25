import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const unitSeparator = "\u001f";

/** Runs a build metadata command without exposing its private arguments. */
export function readBuildMetadata(command, args, projectRoot, env = process.env, input) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} could not read build metadata.`, {
      cause: result.error ?? new Error(result.stderr),
    });
  }
  return result.stdout;
}

/** Identifies desktop build options while preserving the original CLI arguments. */
export function parseBuildArguments(args, hostTarget) {
  const commandIndex = args.findIndex((arg) => !/^(?:-v+|--verbose)$/.test(arg));
  if (args[commandIndex] !== "build") return null;
  const separator = args.indexOf("--", commandIndex + 1);
  const optionsEnd = separator < 0 ? args.length : separator;
  const options = args.slice(commandIndex + 1, optionsEnd);
  if (options.some((option) => ["--help", "-h", "--version", "-V"].includes(option))) return null;
  let target;
  let debug = false;
  let bundles;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (/^-[^-]/.test(option) && !/^(?:-d|-v+|-t.*|-b.*|-f.*)$/.test(option)) {
      throw new Error("Combined short build options are not supported; use separate options.");
    }
    if (/^(?:--config|--runner)(?:=|$)|^-[cr]/.test(option)) {
      throw new Error("Release path checks do not support custom --config or --runner options.");
    }
    if (option === "--debug" || option === "-d") debug = true;
    if (
      option === "--bundles" ||
      option === "-b" ||
      option.startsWith("--bundles=") ||
      /^-b.+/.test(option)
    ) {
      const values = option.startsWith("--bundles=")
        ? [option.slice("--bundles=".length)]
        : option.startsWith("-b") && option !== "-b"
          ? [option.slice(2)]
          : [];
      while (options[index + 1] && !options[index + 1].startsWith("-"))
        values.push(options[++index]);
      bundles = values.flatMap((value) => value.split(","));
      if (bundles.length === 0 || bundles.some((value) => value === ""))
        throw new Error("A build requires valid --bundles values.");
    }
    if (
      option === "--target" ||
      option === "-t" ||
      option.startsWith("--target=") ||
      /^-t.+/.test(option)
    ) {
      const value = option.startsWith("--target=")
        ? option.slice("--target=".length)
        : option.startsWith("-t") && option !== "-t"
          ? option.slice(2)
          : options[++index];
      if (target || !value || value.startsWith("-")) {
        throw new Error("A build requires one valid --target value.");
      }
      target = value;
    }
  }
  const cargoArgs = separator < 0 ? [] : args.slice(separator + 1);
  if (
    cargoArgs.some((arg) =>
      /^(?:--(?:config|target|target-dir|profile|release|manifest-path|artifact-dir|out-dir|bin|bins|lib|example|examples|test|tests|package|workspace|exclude|help|version)|-[rp].*|-[hV])(?:=|$)/.test(
        arg,
      ),
    )
  ) {
    throw new Error(
      "Cargo output, profile, target, and configuration overrides are not supported by release path checks.",
    );
  }
  const buildTarget = target ?? hostTarget;
  return {
    optionsEnd,
    target,
    buildTarget,
    targets:
      buildTarget === "universal-apple-darwin"
        ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
        : [buildTarget],
    profile: debug ? "debug" : "release",
    noBundle: options.includes("--no-bundle"),
    bundles,
  };
}

/** Finds Cargo configuration files that can affect this project invocation. */
export function cargoConfigFiles(projectRoot, cargoHome) {
  const files = new Set();
  let directory = path.join(projectRoot, "src-tauri");
  while (true) {
    for (const name of ["config", "config.toml"]) files.add(path.join(directory, ".cargo", name));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const name of ["config", "config.toml"]) files.add(path.join(cargoHome, name));
  return [...files].filter(existsSync);
}

/** Preserves Cargo's effective environment flags and rejects hidden configuration conflicts. */
function existingRustFlags(env, configFiles) {
  const encoded = env.CARGO_ENCODED_RUSTFLAGS;
  const plain = env.RUSTFLAGS;
  const flags =
    encoded !== undefined
      ? encoded === ""
        ? []
        : encoded.split(unitSeparator)
      : plain !== undefined
        ? plain.split(/\s+/u).filter(Boolean)
        : [];
  if (flags.some((flag) => flag.startsWith("--remap-path-scope"))) {
    throw new Error("Custom --remap-path-scope conflicts with release path checks.");
  }
  for (const file of configFiles) {
    const configuration = readFileSync(file, "utf8").replace(/^\s*#.*$/gm, "");
    if (/\b(?:include|target)["']?\s*=/.test(configuration)) {
      throw new Error(
        "Cargo configuration include or default target settings are not supported by release path checks.",
      );
    }
    if (
      encoded === undefined &&
      plain === undefined &&
      /\brustflags["']?\s*=/.test(configuration)
    ) {
      throw new Error(
        "Move Cargo configuration rustflags into RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS for a release build.",
      );
    }
  }
  if (encoded === undefined && plain === undefined) {
    const conflict = Object.keys(env).find(
      (name) => /^CARGO_(?:BUILD|TARGET_.+)_RUSTFLAGS$/i.test(name) && env[name] !== "",
    );
    if (conflict)
      throw new Error(
        `${conflict} conflicts with release path checks; use RUSTFLAGS or CARGO_ENCODED_RUSTFLAGS.`,
      );
  }
  return flags;
}

/** Retrieves Windows aliases through the filesystem API, without a shell-built pathname. */
export function windowsShortPaths(paths) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class BuildPathAlias { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathNameW(string path, StringBuilder result, uint size); }'
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = foreach ($path in $paths) {
  $buffer = New-Object System.Text.StringBuilder 32768
  $length = [BuildPathAlias]::GetShortPathNameW($path, $buffer, $buffer.Capacity)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot resolve build path alias.' }
  $buffer.ToString()
}
ConvertTo-Json -InputObject @($result) -Compress
`;
  return JSON.parse(
    readBuildMetadata(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      process.cwd(),
      process.env,
      JSON.stringify(paths),
    ),
  );
}

/** Returns slash and drive-letter spellings used by Windows build tools. */
function pathSpellings(source, platform) {
  if (platform !== "win32") return [source];
  const variants = [source.replaceAll("\\", "/"), source.replaceAll("/", "\\")];
  return [
    ...new Set(
      variants.flatMap((value) => [
        value,
        value.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()),
        value.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
      ]),
    ),
  ];
}

/** Orders mappings by specificity; rustc receives the reverse because its last match wins. */
export function createPathMappings(roots, platform = process.platform) {
  const mappings = new Map();
  for (const { source, destination, aliases = [] } of roots) {
    for (const alias of [source, ...aliases]) {
      if (alias.includes("=") || /[\x00-\x1f]/.test(alias)) {
        throw new Error("A build root contains a delimiter unsupported by compiler path mapping.");
      }
      for (const spelling of pathSpellings(alias, platform)) mappings.set(spelling, destination);
    }
  }
  return [...mappings]
    .map(([source, destination]) => ({ source, destination }))
    .sort((left, right) => right.source.length - left.source.length);
}

/** Quotes one argument for cc's documented shell-escaped flag parser. */
function quoteCompilerFlag(flag) {
  return `'${flag.replaceAll("'", "'\\''")}'`;
}

/** Adds Rust and native compiler mappings without changing global toolchain configuration. */
export function createBuildEnvironment({ env, mappings, targets, configFiles = [] }) {
  const supportedTargets = [
    "x86_64-pc-windows-msvc",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ];
  if (targets.some((target) => !supportedTargets.includes(target)))
    throw new Error("Release path checks do not support the selected target.");
  const compilerConflict = Object.keys(env).find((name) => {
    if (env[name] === "" || name === "CC_SHELL_ESCAPED_FLAGS") return false;
    if (/^AWS_LC_SYS_CMAKE_BUILDER(?:_.+)?$/i.test(name) && env[name] === "0") return false;
    return (
      /(?:^|_)(?:CC|CXX|CFLAGS|CXXFLAGS|CPPFLAGS|ARFLAGS|RANLIBFLAGS)(?:_|$)/i.test(name) ||
      /^(?:CL|_CL_|CARGO_BUILD_TARGET|CMAKE_TOOLCHAIN_FILE|AWS_LC_SYS_CMAKE_BUILDER(?:_.+)?)$/i.test(
        name,
      )
    );
  });
  if (compilerConflict)
    throw new Error(
      `${compilerConflict} is not supported by release path checks; remove the custom native compiler setting for this build.`,
    );
  const flags = existingRustFlags(env, configFiles);
  const rustMappings = [...mappings]
    .reverse()
    .map(({ source, destination }) => `--remap-path-prefix=${source}=${destination}`);
  const msvc = targets.every((target) => target.endsWith("-windows-msvc"));
  if (!msvc && targets.some((target) => target.includes("windows"))) {
    throw new Error("Release path checks support the MSVC Windows target.");
  }
  const nativeFlags = msvc
    ? [
        "/experimental:deterministic",
        ...mappings.map(({ source, destination }) => `/pathmap:${source}=${destination}`),
      ]
    : [...mappings]
        .reverse()
        .map(({ source, destination }) => `-ffile-prefix-map=${source}=${destination}`);
  const nativeValue = nativeFlags.map(quoteCompilerFlag).join(" ");
  return {
    ...env,
    CARGO_ENCODED_RUSTFLAGS: [...flags, ...rustMappings].join(unitSeparator),
    CC_SHELL_ESCAPED_FLAGS: "1",
    // cmake-rs 0.1.58 rejoins compiler arguments without quoting paths containing spaces.
    AWS_LC_SYS_CMAKE_BUILDER: "0",
    CFLAGS: nativeValue,
    CXXFLAGS: nativeValue,
  };
}

/** Calculates private roots from the current machine and selected Cargo cache. */
export function buildRoots(projectRoot, targetDirectory, env = process.env) {
  const home = os.homedir();
  const roots = [
    { source: home, destination: "/build/user-source" },
    { source: projectRoot, destination: "/build/project" },
    {
      source: path.resolve(env.CARGO_HOME ?? path.join(home, ".cargo")),
      destination: "/build/cargo",
    },
    {
      source: path.resolve(env.RUSTUP_HOME ?? path.join(home, ".rustup")),
      destination: "/build/rustup",
    },
    { source: targetDirectory, destination: "/build/target" },
  ];
  for (const root of roots) {
    root.aliases = existsSync(root.source) ? [realpathSync.native(root.source)] : [];
  }
  return roots;
}

/** Detects private roots and generic user-profile paths in UTF-8 and both UTF-16 alignments. */
export function containsPrivateBuildPath(bytes, mappings) {
  const texts = [
    bytes.toString("utf8"),
    bytes.toString("utf16le"),
    bytes.subarray(1).toString("utf16le"),
  ];
  const prefixes = mappings
    .flatMap(({ source }) => [source, source.replaceAll("\\", "\\\\")])
    .map((source) => source.toLowerCase());
  return texts.some((text) => {
    const normalized = text.toLowerCase();
    return (
      prefixes.some((prefix) => normalized.includes(prefix)) ||
      /[a-z]:[\\/]+users[\\/]+[^\\/\x00\r\n]+[\\/]|\/(?:users|home)\/[^/\x00\r\n]+\//i.test(text)
    );
  });
}

/** Verifies every file in the selected binary and resource paths. */
export function verifyBuildFiles(paths, mappings) {
  let count = 0;
  for (const file of paths) {
    if (statSync(file).isDirectory()) {
      count += verifyBuildFiles(
        readdirSync(file).map((entry) => path.join(file, entry)),
        mappings,
      );
    } else {
      if (containsPrivateBuildPath(readFileSync(file), mappings)) {
        throw new Error(
          "Build path privacy check failed: a binary or bundled resource contains a private build path.",
        );
      }
      count += 1;
    }
  }
  return count;
}

/** Redacts runtime-only roots from tool diagnostics before writing build logs. */
export function redactBuildPaths(message, mappings) {
  let redacted = message;
  for (const { source, destination } of mappings) {
    for (const spelling of [source.replaceAll("\\", "\\\\"), source]) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      redacted = redacted.replace(
        new RegExp(escaped, /^[a-z]:/i.test(source) ? "gi" : "g"),
        destination,
      );
    }
  }
  return redacted.replace(/[a-z]:[\\/]+users[\\/]+[^\\/\r\n"'<>]+/gi, "/build/user-source");
}

/** Inserts the generated Tauri overlay before Cargo's argument separator. */
export function appendBuildConfig(args, optionsEnd, configPath) {
  return [...args.slice(0, optionsEnd), "--config", configPath, ...args.slice(optionsEnd)];
}

/** Locates the main executable for the CLI's selected target and profile. */
export function buildOutputDirectory(targetDirectory, build) {
  return path.join(targetDirectory, ...(build.target ? [build.target] : []), build.profile);
}
