import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

const sourceManifestPath = fileURLToPath(new URL("./license-sources.json", import.meta.url));
const owner = "gitlab-manager-third-party-notices-v1";
const markerName = ".generated-files.json";
let registryArchive;
const supportedTargets = new Set([
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
]);

/** Return a stable digest without adding machine-specific metadata. */
export function digest(bytes, algorithm = "sha256") {
  return createHash(algorithm).update(bytes).digest("hex");
}

/** Reject changed downloaded or locally supplied license material. */
export function verifyDigest(bytes, expected, label, algorithm = "sha256") {
  if (digest(bytes, algorithm) !== expected) throw new Error(`License digest mismatch: ${label}`);
  return bytes;
}

/** Keep generated paths inside their owning directory, including symlink checks. */
function ownedPath(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid generated license path");
  }
  const result = path.resolve(root, relative);
  if (!result.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("Generated license path escapes its directory");
  }
  for (let current = result; current !== path.resolve(root); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("Generated license paths must not contain symlinks");
    }
  }
  return result;
}

/** List files with relative names; links are not accepted in generated output. */
function listFiles(root, prefix = "") {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Generated license directory contains a symlink");
    return entry.isDirectory() ? listFiles(root, relative) : [relative];
  });
}

/** Replace only intact files recorded by this generator; unknown user files stop the build. */
export function writeGeneratedResources(resourceDirectory, files) {
  const markerPath = path.join(resourceDirectory, markerName);
  let previous = {};
  if (fs.existsSync(resourceDirectory)) {
    if (fs.lstatSync(resourceDirectory).isSymbolicLink())
      throw new Error("License output must not be a symlink");
    const existing = listFiles(resourceDirectory);
    if (existing.length) {
      if (!fs.existsSync(markerPath)) throw new Error("License output contains unowned files");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.owner !== owner || typeof marker.files !== "object")
        throw new Error("Invalid license output marker");
      previous = marker.files;
      for (const name of existing.filter((name) => name !== markerName)) {
        if (!Object.hasOwn(previous, name)) throw new Error(`Unowned license output file: ${name}`);
        verifyDigest(fs.readFileSync(ownedPath(resourceDirectory, name)), previous[name], name);
      }
      for (const name of Object.keys(previous)) {
        if (!fs.existsSync(ownedPath(resourceDirectory, name)))
          throw new Error(`Generated license file missing: ${name}`);
      }
    }
  }
  for (const name of Object.keys(files)) ownedPath(resourceDirectory, name);
  fs.mkdirSync(resourceDirectory, { recursive: true });
  for (const name of Object.keys(previous)) {
    if (!Object.hasOwn(files, name)) {
      fs.unlinkSync(ownedPath(resourceDirectory, name));
      for (
        let directory = path.dirname(ownedPath(resourceDirectory, name));
        directory !== path.resolve(resourceDirectory);
        directory = path.dirname(directory)
      ) {
        if (fs.readdirSync(directory).length) break;
        fs.rmdirSync(directory);
      }
    }
  }
  for (const [name, bytes] of Object.entries(files)) {
    const destination = ownedPath(resourceDirectory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, digest(bytes)]),
  );
  fs.writeFileSync(markerPath, `${JSON.stringify({ owner, files: hashes }, null, 2)}\n`);
}

/** Add license resources through a build-only overlay with project-relative paths. */
export function createResourceOverlay(config) {
  const resources = config.bundle?.resources ?? {};
  if (typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error("License generation requires the bundle.resources map used by this project");
  }
  for (const [source, destination] of Object.entries(resources)) {
    if (
      [source, destination].some(
        (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value),
      )
    )
      throw new Error("Bundle resources must use relative paths");
  }
  return { bundle: { resources: { ...resources, "target/third-party-licenses/": "licenses/" } } };
}

/** Run read-only Cargo/rustc queries while keeping local paths out of public diagnostics. */
function query(program, args, projectRoot) {
  try {
    return execFileSync(program, args, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 40_000_000,
    });
  } catch (cause) {
    throw new Error(
      `${program} dependency query failed (exit ${cause.status ?? "unknown"}); check the locked dependency/toolchain installation`,
      { cause },
    );
  }
}

/** Find an installed dependency using Node's directory resolution rules. */
function packageDirectory(name, from, optional = false) {
  for (let current = from; ; current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.dirname(current) === current) break;
  }
  if (optional) return undefined;
  throw new Error(`Installed dependency missing: ${name}`);
}

/** Collect the installed frontend runtime closure, excluding optional type-only peers. */
function frontendPackages(projectRoot, rootPackage) {
  const queue = Object.keys(rootPackage.dependencies).map((name) => ({ name, from: projectRoot }));
  const seen = new Set();
  const result = [];
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const directory = packageDirectory(name, from, optional);
    if (!directory || seen.has(directory)) continue;
    seen.add(directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    result.push({ ...manifest, directory });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dependency, from: directory });
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({ name: dependency, from: directory, optional: true });
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (peer.startsWith("@types/")) continue;
      queue.push({
        name: peer,
        from: directory,
        optional: manifest.peerDependenciesMeta?.[peer]?.optional === true,
      });
    }
  }
  return result;
}

/** Read every top-level license/notice and explicit license directory shipped by a package. */
function licensePaths(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (!/^(licen[sc]e|copying|notice|copyright|unlicen[sc]e)(?:$|[._-]|s$)/i.test(entry.name))
        return [];
      return entry.isDirectory() ? listFiles(directory, entry.name) : [entry.name];
    })
    .filter((name) => !name.endsWith(".spdx"));
}

/** Use exact-version public license material, caching only bytes with the expected digest. */
async function publicSource(source, cacheDirectory) {
  const url = new URL(source.url);
  if (
    url.protocol !== "https:" ||
    !["raw.githubusercontent.com", "api.nuget.org"].includes(url.hostname)
  ) {
    throw new Error("Unsupported public license source");
  }
  const cachePath = ownedPath(cacheDirectory, source.sha256);
  if (fs.existsSync(cachePath))
    return verifyDigest(fs.readFileSync(cachePath), source.sha256, url.pathname);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (cause) {
    throw new Error(`License source unavailable: ${url.hostname}${url.pathname}`, { cause });
  }
  if (!response.ok) throw new Error(`License source HTTP ${response.status}: ${url.pathname}`);
  const bytes = verifyDigest(
    Buffer.from(await response.arrayBuffer()),
    source.sha256,
    url.pathname,
  );
  fs.mkdirSync(cacheDirectory, { recursive: true });
  fs.writeFileSync(cachePath, bytes, { flag: "wx" });
  return bytes;
}

/** Extract selected original files from an integrity-checked, ordinary NuGet ZIP. */
function zipFiles(archive, names) {
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65_557) && archive.readUInt32LE(end) !== 0x06054b50)
    end--;
  if (end < Math.max(0, archive.length - 65_557)) throw new Error("Invalid license archive");
  const result = new Map();
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < archive.readUInt16LE(end + 10); index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid license ZIP directory");
    const nameLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (names.includes(name)) {
      const local = archive.readUInt32LE(offset + 42);
      const start =
        local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const compressed = archive.subarray(start, start + archive.readUInt32LE(offset + 20));
      const method = archive.readUInt16LE(offset + 10);
      if (![0, 8].includes(method)) throw new Error("Unsupported license ZIP compression");
      result.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    }
    offset +=
      46 + nameLength + archive.readUInt16LE(offset + 30) + archive.readUInt16LE(offset + 32);
  }
  for (const name of names)
    if (!result.has(name)) throw new Error(`License archive entry missing: ${name}`);
  return result;
}

/** Locate a file in a checksum-verified crates.io tar archive. */
function archiveEntry(archive, name) {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    const filename = header.toString("utf8", 0, 100).split("\0")[0];
    if (!filename) break;
    const prefix = header.toString("utf8", 345, 500).split("\0")[0];
    const size = Number.parseInt(header.toString("ascii", 124, 136).replaceAll("\0", "").trim(), 8);
    if (!Number.isSafeInteger(size)) throw new Error("Invalid crates.io source archive");
    if ((prefix ? `${prefix}/${filename}` : filename) === name)
      return archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Registry notice missing from locked source archive: ${name}`);
}

/** Read registry source files and reject local modifications of the original notice. */
function registryFile(crate, relative) {
  const directory = path.dirname(crate.manifest_path);
  const bytes = fs.readFileSync(ownedPath(directory, relative));
  const archiveName = `${crate.name}-${crate.version}`;
  const archivePath = path.resolve(
    directory,
    "../../../cache",
    path.basename(path.dirname(directory)),
    `${archiveName}.crate`,
  );
  if (!crate.lockedChecksum)
    throw new Error(`Registry source is not checksum-locked: ${crate.name}`);
  if (registryArchive?.path !== archivePath || registryArchive.checksum !== crate.lockedChecksum) {
    const compressed = verifyDigest(
      fs.readFileSync(archivePath),
      crate.lockedChecksum,
      `${archiveName}.crate`,
    );
    registryArchive = {
      path: archivePath,
      checksum: crate.lockedChecksum,
      bytes: gunzipSync(compressed),
    };
  }
  return verifyDigest(
    bytes,
    digest(archiveEntry(registryArchive.bytes, `${archiveName}/${relative}`)),
    `${crate.name}/${relative}`,
  );
}

/** Collect one crate's original notices or its explicitly reviewed missing-file sources. */
export async function collectCrateLicenses(crate, crates, sources, cacheDirectory) {
  const id = `${crate.name}@${crate.version}`;
  const directory = path.dirname(crate.manifest_path);
  const paths = [...licensePaths(directory), ...(sources.rustExtra[id] ?? [])];
  const files = Object.fromEntries(
    paths.map((relative) => [relative, registryFile(crate, relative)]),
  );
  if (paths.length) return { files };
  const rule = sources.rustMissing[id];
  if (!rule) throw new Error(`Original license material missing; review required: ${id}`);
  const vcs = JSON.parse(fs.readFileSync(path.join(directory, ".cargo_vcs_info.json"), "utf8"));
  if (vcs.git.sha1 !== rule.vcsCommit) throw new Error(`License source commit mismatch: ${id}`);
  for (const source of rule.files ?? [])
    files[source.name] = await publicSource(source, cacheDirectory);
  if (rule.localLicense) {
    const other = crates.get(rule.localLicense.package);
    if (!other) throw new Error(`Shared license source missing: ${id}`);
    files["LICENSE-MPL-2.0.txt"] = verifyDigest(
      registryFile(other, rule.localLicense.path),
      rule.localLicense.sha256,
      id,
    );
  }
  if (rule.sourceNotice) {
    const bytes = registryFile(crate, rule.sourceNotice.path);
    files["SOURCE-LICENSE-NOTICE.txt"] = Buffer.from(
      bytes.toString("utf8").split("\n").slice(0, rule.sourceNotice.lineCount).join("\n") + "\n",
    );
  }
  if (!Object.keys(files).length) throw new Error(`Original license material missing: ${id}`);
  return { files, sourceRule: rule };
}

/** Generate auditable, platform-specific notice resources before Tauri packaging. */
export async function generateThirdPartyNotices({ projectRoot, targets }) {
  projectRoot = fs.realpathSync(projectRoot);
  targets = [...new Set(targets)].sort();
  if (!targets.length || targets.some((target) => !supportedTargets.has(target)))
    throw new Error("Unreviewed license target");
  const sources = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
  const resourceDirectory = ownedPath(projectRoot, "src-tauri/target/third-party-licenses");
  const cacheDirectory = ownedPath(projectRoot, "src-tauri/target/license-source-cache");
  const configPath = ownedPath(projectRoot, "src-tauri/target/third-party-licenses.config.json");
  const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const files = { "APP-LICENSE.txt": fs.readFileSync(path.join(projectRoot, "LICENSE")) };
  const index = {
    schemaVersion: 1,
    applicationVersion: rootPackage.version,
    targets,
    components: [],
    systemDependencies: [],
  };
  const crates = new Map();
  const runtimeIds = new Set();
  const lockedChecksums = new Map(
    fs
      .readFileSync(path.join(projectRoot, "src-tauri/Cargo.lock"), "utf8")
      .split(/^\[\[package\]\]/m)
      .flatMap((entry) => {
        const name = entry.match(/^name = "([^"]+)"/m)?.[1];
        const version = entry.match(/^version = "([^"]+)"/m)?.[1];
        const checksum = entry.match(/^checksum = "([a-f0-9]{64})"/m)?.[1];
        return name && version && checksum ? [[`${name}@${version}`, checksum]] : [];
      }),
  );

  // 1. Use the selected Cargo target graphs; proc macros remain in the build/test inventory.
  for (const target of targets) {
    const args = ["--manifest-path", "src-tauri/Cargo.toml", "--locked"];
    const metadata = JSON.parse(
      query(
        "cargo",
        ["metadata", ...args, "--format-version", "1", "--filter-platform", target],
        projectRoot,
      ),
    );
    for (const crate of metadata.packages.filter((crate) => crate.source !== null)) {
      if (crate.source !== "registry+https://github.com/rust-lang/crates.io-index")
        throw new Error(`Unreviewed dependency source: ${crate.name}`);
      crates.set(`${crate.name}@${crate.version}`, {
        ...crate,
        lockedChecksum: lockedChecksums.get(`${crate.name}@${crate.version}`),
      });
    }
    const tree = query(
      "cargo",
      [
        "tree",
        ...args,
        "--target",
        target,
        "--edges",
        "normal,no-proc-macro",
        "--prefix",
        "none",
        "--format",
        "{p}",
      ],
      projectRoot,
    );
    for (const line of tree.split("\n")) {
      const match = line.match(/^([a-zA-Z0-9_-]+) v([^\s]+)/);
      if (match) runtimeIds.add(`${match[1]}@${match[2]}`);
    }
  }

  // 2. Preserve package notices verbatim, including nested native-code notices.
  for (const crate of [...crates.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"),
  )) {
    const id = `${crate.name}@${crate.version}`;
    if (!crate.license) throw new Error(`Crate license declaration missing: ${id}`);
    const notices = await collectCrateLicenses(crate, crates, sources, cacheDirectory);
    const prefix = `cargo/${crate.name}-${crate.version}`;
    for (const [name, bytes] of Object.entries(notices.files)) files[`${prefix}/${name}`] = bytes;
    index.components.push({
      name: crate.name,
      version: crate.version,
      ecosystem: "cargo",
      role: runtimeIds.has(id) ? "runtime-dependency-graph" : "build-or-test-dependency",
      license: crate.license,
      sourceUrl: `https://crates.io/api/v1/crates/${encodeURIComponent(crate.name)}/${encodeURIComponent(crate.version)}/download`,
      notices: Object.keys(notices.files).map((name) => `${prefix}/${name}`),
      ...(notices.sourceRule ? { licenseSources: notices.sourceRule } : {}),
    });
  }
  const frontend = frontendPackages(projectRoot, rootPackage).map((pkg) => ({
    ...pkg,
    role: "frontend-runtime-dependency",
  }));
  const viteDirectory = packageDirectory("vite", projectRoot);
  for (const [name, from] of [
    ["vite", projectRoot],
    ["rolldown", viteDirectory],
  ]) {
    const directory = packageDirectory(name, from);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    frontend.push({ ...pkg, directory, role: "frontend-build-tool" });
  }
  for (const pkg of frontend.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const paths = licensePaths(pkg.directory);
    if (!pkg.license || !paths.length)
      throw new Error(`Frontend license material missing: ${pkg.name}@${pkg.version}`);
    const prefix = `npm/${pkg.name.replaceAll("/", "_")}-${pkg.version}`;
    for (const name of paths)
      files[`${prefix}/${name}`] = fs.readFileSync(ownedPath(pkg.directory, name));
    index.components.push({
      name: pkg.name,
      version: pkg.version,
      ecosystem: "npm",
      role: pkg.role,
      license: pkg.license,
      sourceUrl: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      notices: paths.map((name) => `${prefix}/${name}`),
    });
  }

  // 3. Include the actual standard library and Windows components outside Cargo's graph.
  const sysroot = query("rustc", ["--print", "sysroot"], projectRoot).trim();
  const rustDocumentation = path.join(sysroot, "share/doc/rust");
  const libraryNotice = "COPYRIGHT-library.html";
  if (!fs.existsSync(path.join(rustDocumentation, libraryNotice)))
    throw new Error(
      "This Rust toolchain is missing COPYRIGHT-library.html; run rustup component add rust-docs for this same toolchain before packaging",
    );
  const rustNotices = [
    libraryNotice,
    ...listFiles(path.join(rustDocumentation, "licenses")).map((name) => `licenses/${name}`),
  ];
  for (const name of rustNotices)
    files[`rust-standard-library/${name}`] = fs.readFileSync(ownedPath(rustDocumentation, name));
  const rustVersion = query("rustc", ["--version"], projectRoot).trim();
  index.components.push({
    name: "Rust standard library",
    version: rustVersion,
    ecosystem: "toolchain",
    role: "runtime-toolchain-library",
    notices: rustNotices.map((name) => `rust-standard-library/${name}`),
  });
  if (targets.some((target) => target.endsWith("windows-msvc"))) {
    const windows = sources.windows;
    const cli = JSON.parse(
      fs.readFileSync(
        path.join(packageDirectory("@tauri-apps/cli", projectRoot), "package.json"),
        "utf8",
      ),
    );
    if (cli.version !== windows.tauriCliVersion)
      throw new Error("Tauri CLI changed; review Windows installer component license pins");
    const webview = crates.get(windows.webview2.crate);
    if (!webview) throw new Error("WebView2 loader crate changed; review its SDK license pins");
    for (const target of targets.filter((target) => target.endsWith("windows-msvc"))) {
      const loader = windows.webview2.staticLoaders[target.split("-")[0]];
      if (!loader) throw new Error("Unreviewed WebView2 loader architecture");
      verifyDigest(registryFile(webview, loader.path), loader.sha256, "WebView2LoaderStatic.lib");
    }
    const sdk = await publicSource(windows.webview2, cacheDirectory);
    const sdkNotices = zipFiles(
      sdk,
      windows.webview2.files.map((file) => file.path),
    );
    for (const file of windows.webview2.files)
      files[`windows/webview2-sdk/${file.path}`] = verifyDigest(
        sdkNotices.get(file.path),
        file.sha256,
        file.path,
      );
    index.components.push({
      name: "Microsoft WebView2 SDK loader",
      version: windows.webview2.version,
      ecosystem: "native",
      role: "runtime-static-library",
      sourceUrl: windows.webview2.url,
      notices: windows.webview2.files.map((file) => `windows/webview2-sdk/${file.path}`),
    });
    for (const [key, name] of [
      ["nsis", "NSIS"],
      ["nsisUtils", "nsis_tauri_utils"],
    ]) {
      const component = windows[key];
      const relative = `windows/${key}/${component.license.name}`;
      files[relative] = await publicSource(component.license, cacheDirectory);
      index.components.push({
        name,
        version: component.version,
        ecosystem: "installer",
        role: "nsis-installer-component",
        sourceUrl: component.sourceUrl,
        notices: [relative],
      });
    }
    index.systemDependencies.push({
      name: "Microsoft Edge WebView2 Runtime",
      distribution:
        "System-installed or downloaded by the installer; the runtime itself is not embedded in this application's package",
      sourceUrl: "https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution",
    });
  }
  if (targets.some((target) => target.endsWith("apple-darwin")))
    index.systemDependencies.push({
      name: "Apple system frameworks and WKWebView",
      distribution:
        "Provided by macOS; native package contents still require platform verification",
    });
  if (targets.some((target) => target.endsWith("linux-gnu")))
    index.systemDependencies.push({
      name: "GTK, WebKitGTK, Secret Service and other system libraries",
      distribution:
        "DEB system dependencies and AppImage bundled native libraries require verification on the Linux build host; this dependency inventory is not an AppImage native-library audit",
    });

  // 4. Write a complete current inventory; remove only previously owned obsolete files.
  const counts = Object.fromEntries(
    [...new Set(index.components.map((component) => component.role))].map((role) => [
      role,
      index.components.filter((component) => component.role === role).length,
    ]),
  );
  const header = [
    "GitLab Manager — third-party notices",
    `Application: ${rootPackage.version}`,
    `Targets: ${targets.join(", ")}`,
    "",
    "Original license and notice texts are retained in the relative files listed below.",
    "Runtime and build/test roles describe dependency graphs, not exact final machine-code linkage.",
    "Vite and Rolldown are listed separately as frontend build tools, including their generated runtime helpers.",
    "Public upstream copyright holders and contact details are retained as required by their licenses.",
    "For MPL-2.0 components, the exact-version source archive is available at each component's source URL.",
    "The application license does not replace or restrict any third-party license.",
    "",
    ...index.components.flatMap((component) => [
      `${component.name} ${component.version} [${component.role}]`,
      ...(component.license ? [`License: ${component.license}`] : []),
      ...(component.sourceUrl ? [`Source: ${component.sourceUrl}`] : []),
      ...component.notices.map((name) => `  ${name}`),
      "",
    ]),
    ...index.systemDependencies.flatMap((component) => [
      component.name,
      component.distribution,
      ...(component.sourceUrl ? [component.sourceUrl] : []),
      "",
    ]),
  ];
  files["NOTICE.txt"] = Buffer.from(`${header.join("\n")}\n`);
  files["index.json"] = Buffer.from(`${JSON.stringify({ ...index, counts }, null, 2)}\n`);
  writeGeneratedResources(resourceDirectory, files);
  const config = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );
  fs.writeFileSync(configPath, `${JSON.stringify(createResourceOverlay(config), null, 2)}\n`);
  return { configPath, resourceDirectory, counts };
}

/** Require every current generated license resource in the NSIS installation file list. */
export function verifyNoticeInstallEntries(script, relativeFiles) {
  const installed = new Set(
    [...script.matchAll(/^\s*File \/a "\/oname=([^"]+)"/gm)].map((match) =>
      match[1].replaceAll("\\", "/"),
    ),
  );
  for (const relative of relativeFiles) {
    if (!installed.has(`licenses/${relative}`)) {
      throw new Error(`NSIS script does not install license resource: ${relative}`);
    }
  }
}

/** Verify the toolset actually used by this NSIS script against the reviewed license pins. */
export function verifyWindowsInstallerLicenses({ projectRoot, nsisScriptPath }) {
  const sources = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
  const script = fs.readFileSync(nsisScriptPath, "utf8");
  const pluginPath = script.match(/^!define ADDITIONALPLUGINSPATH "([^"]+)"/m)?.[1];
  if (!pluginPath || !path.isAbsolute(pluginPath))
    throw new Error("NSIS script does not identify its actual plugin toolset");
  const nsisDirectory = path.resolve(pluginPath, "../../..");
  verifyDigest(
    fs.readFileSync(path.join(nsisDirectory, "NSIS.exe")),
    sources.windows.nsis.nsisExecutableSHA1,
    "NSIS toolset",
    "sha1",
  );
  verifyDigest(
    fs.readFileSync(path.join(pluginPath, "nsis_tauri_utils.dll")),
    sources.windows.nsisUtils.dllSHA1,
    "NSIS Tauri plugin",
    "sha1",
  );
  const actualLicense = fs
    .readFileSync(path.join(nsisDirectory, "COPYING"), "utf8")
    .replaceAll("\r\n", "\n");
  verifyDigest(Buffer.from(actualLicense), sources.windows.nsis.license.sha256, "NSIS COPYING");
  if (!script.includes('!define INSTALLWEBVIEW2MODE "downloadBootstrapper"'))
    throw new Error(
      "WebView2 distribution mode changed; review its runtime redistribution license",
    );
  const resourceDirectory = ownedPath(projectRoot, "src-tauri/target/third-party-licenses");
  verifyNoticeInstallEntries(script, listFiles(resourceDirectory));
  return { nsis: sources.windows.nsis.version, nsisUtils: sources.windows.nsisUtils.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const args = process.argv.slice(2);
  const targets = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--target" || !args[index + 1])
      throw new Error("Usage: generate-third-party-notices.mjs [--target triple]");
    targets.push(args[++index]);
  }
  if (!targets.length) targets.push(query("rustc", ["-vV"], projectRoot).match(/^host: (.+)$/m)[1]);
  try {
    const result = await generateThirdPartyNotices({ projectRoot, targets });
    console.log(`Third-party notices generated: ${JSON.stringify(result.counts)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
