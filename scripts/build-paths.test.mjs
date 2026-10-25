import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  appendBuildConfig,
  buildOutputDirectory,
  containsPrivateBuildPath,
  createBuildEnvironment,
  createPathMappings,
  parseBuildArguments,
  redactBuildPaths,
  verifyBuildFiles,
} from "./build-paths.mjs";

const windowsTarget = "x86_64-pc-windows-msvc";
const exampleHome = ["C:", "Users", "Example Builder"].join("\\");
const exampleShortHome = ["C:", "Users", "EXAMPL~1"].join("\\");
const roots = [
  { source: exampleHome, aliases: [exampleShortHome], destination: "/build/user-source" },
  {
    source: `${exampleHome}\\example project`,
    aliases: [`${exampleShortHome}\\EXAMPL~2`],
    destination: "/build/project",
  },
];
const mappings = createPathMappings(roots, "win32");
const fixtures = [];

after(() => {
  for (const directory of fixtures) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("example-build-config-"));
    rmSync(directory, { recursive: true });
  }
});

/** Constructs a release environment using only fictional build roots. */
function releaseEnvironment(env = {}, configFiles = []) {
  return createBuildEnvironment({ env, mappings, targets: [windowsTarget], configFiles });
}

test("passes non-build and help commands through without release preparation", () => {
  for (const args of [
    ["dev"],
    ["info"],
    ["--version"],
    ["build", "--help"],
    ["-v", "build", "-h"],
    ["build", "--version"],
  ]) {
    assert.equal(parseBuildArguments(args, windowsTarget), null);
  }
});

test("retains target, profile, bundles, no-bundle and Cargo argument boundaries", () => {
  const args = [
    "-v",
    "build",
    "--target",
    windowsTarget,
    "--debug",
    "--no-bundle",
    "--bundles",
    "nsis,msi",
    "--",
    "--locked",
  ];
  const build = parseBuildArguments(args, "example-host");
  assert.equal(build.target, windowsTarget);
  assert.equal(build.profile, "debug");
  assert.equal(build.noBundle, true);
  assert.deepEqual(build.bundles, ["nsis", "msi"]);
  assert.deepEqual(appendBuildConfig(args, build.optionsEnd, "example.config.json"), [
    ...args.slice(0, -2),
    "--config",
    "example.config.json",
    "--",
    "--locked",
  ]);
  assert.equal(buildOutputDirectory("target", build), path.join("target", windowsTarget, "debug"));
  assert.equal(
    buildOutputDirectory("target", parseBuildArguments(["build"], windowsTarget)),
    path.join("target", "release"),
  );
});

test("expands universal macOS into real dependency targets", () => {
  const build = parseBuildArguments(["build", "--target=universal-apple-darwin"], windowsTarget);
  assert.deepEqual(build.targets, ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  assert.equal(build.target, "universal-apple-darwin");
  assert.equal(
    parseBuildArguments(["build", `-t${windowsTarget}`, "-d", "-bnsis"], "example-host")
      .buildTarget,
    windowsTarget,
  );
});

test("rejects unsupported configuration and output overrides explicitly", () => {
  for (const args of [
    ["build", "--config", "example.json"],
    ["build", "-cexample.json"],
    ["build", "--runner=cargo"],
    ["build", "--", "--target-dir=example"],
    ["build", "--", "--profile", "example"],
    ["build", "--", "-pexample"],
    ["build", "-dv"],
    ["build", "--target"],
    ["build", "-t", windowsTarget, "--target", windowsTarget],
  ]) {
    assert.throws(() => parseBuildArguments(args, windowsTarget));
  }
});

test("preserves encoded Rust flags with spaces and their precedence over RUSTFLAGS", () => {
  const original = ["-C", "link-arg=example value", "--cfg=example"].join("\u001f");
  const env = releaseEnvironment({
    CARGO_ENCODED_RUSTFLAGS: original,
    RUSTFLAGS: "--cfg=ignored_by_cargo",
  });
  assert.equal(env.CARGO_ENCODED_RUSTFLAGS.slice(0, original.length + 1), `${original}\u001f`);
  assert.equal(env.RUSTFLAGS, "--cfg=ignored_by_cargo");
  assert.deepEqual(
    releaseEnvironment({ RUSTFLAGS: "-C opt-level=2" })
      .CARGO_ENCODED_RUSTFLAGS.split("\u001f")
      .slice(0, 2),
    ["-C", "opt-level=2"],
  );
  assert.equal(env.AWS_LC_SYS_CMAKE_BUILDER, "0");
  assert.equal(releaseEnvironment({ AWS_LC_SYS_CMAKE_BUILDER: "0" }).AWS_LC_SYS_CMAKE_BUILDER, "0");
});

test("rejects compiler and lower-priority Rust flag conflicts without printing values", () => {
  for (const name of [
    "CFLAGS",
    "CXXFLAGS",
    "CFLAGS_x86_64_pc_windows_msvc",
    "TARGET_CFLAGS",
    "CC",
    "CL",
    "ARFLAGS",
    "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
    "CMAKE_TOOLCHAIN_FILE",
    "AWS_LC_SYS_CMAKE_BUILDER",
  ]) {
    assert.throws(
      () => releaseEnvironment({ [name]: "private-example-setting" }),
      (error) => error.message.includes(name) && !error.message.includes("private-example-setting"),
    );
  }
  assert.throws(
    () => releaseEnvironment({ RUSTFLAGS: "--remap-path-scope=diagnostics" }),
    /remap-path-scope/,
  );
  assert.throws(
    () => createBuildEnvironment({ env: {}, mappings, targets: ["aarch64-pc-windows-msvc"] }),
    /selected target/,
  );
});

test("refuses Cargo configuration flags that would otherwise be silently shadowed", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "example-build-config-"));
  fixtures.push(directory);
  const configuration = path.join(directory, "config.toml");
  writeFileSync(configuration, '[build]\nrustflags = ["--cfg=example"]\n');
  assert.throws(() => releaseEnvironment({}, [configuration]), /configuration rustflags/);
  assert.doesNotThrow(() => releaseEnvironment({ RUSTFLAGS: "--cfg=effective" }, [configuration]));
});

test("maps long, slash and 8.3 spellings using compiler-specific precedence", () => {
  const env = releaseEnvironment();
  assert.equal(mappings[0].destination, "/build/project");
  for (const source of [
    exampleHome,
    exampleHome.replaceAll("\\", "/"),
    exampleShortHome,
    exampleShortHome.replaceAll("\\", "/"),
  ]) {
    assert.ok(mappings.some((mapping) => mapping.source === source));
  }
  assert.ok(env.CFLAGS.startsWith("'/experimental:deterministic' '/pathmap:"));
  assert.ok(env.CFLAGS.indexOf("=/build/project") < env.CFLAGS.indexOf("=/build/user-source"));
  assert.ok(
    env.CARGO_ENCODED_RUSTFLAGS.indexOf("=/build/user-source") <
      env.CARGO_ENCODED_RUSTFLAGS.indexOf("=/build/project"),
  );
  assert.equal(env.CC_SHELL_ESCAPED_FLAGS, "1");
  assert.equal(env.CFLAGS, env.CXXFLAGS);
});

test("prepares the same path gate for each macOS and Linux CI target", () => {
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
  ]) {
    const env = createBuildEnvironment({ env: {}, mappings, targets: [target] });
    assert.ok(env.CFLAGS.startsWith("'-ffile-prefix-map="));
    assert.ok(env.CFLAGS.indexOf("=/build/user-source") < env.CFLAGS.indexOf("=/build/project"));
    assert.equal(env.AWS_LC_SYS_CMAKE_BUILDER, "0");
  }
});

test("detects private build roots in UTF-8 and either UTF-16 byte alignment", () => {
  const otherProfile = ["D:", "Users", "Another Example", "example.c"].join("\\");
  for (const source of [
    `${exampleHome}\\example.c`,
    `${exampleShortHome.replaceAll("\\", "/")}/example.c`,
    otherProfile,
    otherProfile.replaceAll("\\", "\\\\"),
  ]) {
    assert.equal(containsPrivateBuildPath(Buffer.from(source), mappings), true);
    assert.equal(containsPrivateBuildPath(Buffer.from(source, "utf16le"), mappings), true);
    assert.equal(
      containsPrivateBuildPath(
        Buffer.concat([Buffer.from([0]), Buffer.from(source, "utf16le")]),
        mappings,
      ),
      true,
    );
  }
  assert.equal(
    containsPrivateBuildPath(
      Buffer.from("/build/user-source/.cargo/example.rs /build/project/example.c"),
      mappings,
    ),
    false,
  );
  const outsideHome = createPathMappings(
    [{ source: "/work/example-private", destination: "/build/project" }],
    "linux",
  );
  assert.equal(
    containsPrivateBuildPath(Buffer.from("/work/example-private/example.c"), outsideHome),
    true,
  );
});

test("redacts diagnostics without exposing long or short user-profile names", () => {
  const log = [
    `${exampleHome}\\example project\\file.rs`,
    `${exampleShortHome}\\file.c`,
    ["D:", "Users", "Another Example", "file.c"].join("\\"),
  ].join(" ");
  const redacted = redactBuildPaths(log, mappings);
  assert.equal(redacted.includes("Example Builder"), false);
  assert.equal(redacted.includes("EXAMPL~1"), false);
  assert.equal(redacted.includes("Another Example"), false);
  assert.equal(redactBuildPaths(exampleHome.toUpperCase(), mappings), "/build/user-source");
});

test("rejects a private path in a bundled resource without including its contents in diagnostics", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "example-build-config-"));
  fixtures.push(directory);
  writeFileSync(path.join(directory, "NOTICE.txt"), "Example license text");
  assert.equal(verifyBuildFiles([directory], mappings), 1);
  writeFileSync(
    path.join(directory, "example.bin"),
    Buffer.concat([Buffer.from([0]), Buffer.from(`${exampleHome}\\example.c`, "utf16le")]),
  );
  assert.throws(
    () => verifyBuildFiles([directory], mappings),
    (error) =>
      error.message.includes("privacy check failed") && !error.message.includes("Example Builder"),
  );
});
