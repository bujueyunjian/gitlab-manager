import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCrateLicenses,
  createResourceOverlay,
  digest,
  verifyDigest,
  verifyNoticeInstallEntries,
  writeGeneratedResources,
} from "./generate-third-party-notices.mjs";

/** Create an isolated fixture and remove only this test's verified temporary directory. */
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "gitlab-manager-license-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    fs.rmSync(directory, { recursive: true });
  });
  return directory;
}

/** Missing upstream material must stop generation without creating substitute text. */
test("a dependency without original license material fails", async (t) => {
  const directory = fixture(t);
  await assert.rejects(
    collectCrateLicenses(
      {
        name: "example-package",
        version: "1.0.0",
        manifest_path: path.join(directory, "Cargo.toml"),
      },
      new Map(),
      { rustExtra: {}, rustMissing: {} },
      path.join(directory, "cache"),
    ),
    /Original license material missing; review required: example-package@1.0.0/,
  );
  assert.deepEqual(fs.readdirSync(directory), []);
});

/** A changed pinned license must not be accepted as the reviewed source. */
test("a pinned source hash mismatch fails", () => {
  const original = Buffer.from("Example Contributors\nhttps://example.com/license\n");
  assert.throws(
    () => verifyDigest(Buffer.from("changed"), digest(original), "example-license"),
    /License digest mismatch/,
  );
  assert.equal(verifyDigest(original, digest(original), "example-license"), original);
});

/** A new inventory removes only obsolete intact files that this generator owned. */
test("regeneration removes old dependency notices and keeps the current inventory", (t) => {
  const directory = path.join(fixture(t), "output");
  writeGeneratedResources(directory, {
    "cargo/old/LICENSE": Buffer.from("Original example notice\n"),
  });
  writeGeneratedResources(directory, {
    "cargo/current/LICENSE": Buffer.from("Current example notice\n"),
  });
  assert.equal(fs.existsSync(path.join(directory, "cargo/old/LICENSE")), false);
  assert.equal(
    fs.readFileSync(path.join(directory, "cargo/current/LICENSE"), "utf8"),
    "Current example notice\n",
  );
  const marker = fs.readFileSync(path.join(directory, ".generated-files.json"), "utf8");
  assert.equal(marker.includes(directory), false);
  assert.equal(marker.includes("cargo/old/LICENSE"), false);
});

/** Unowned or edited files must survive a rejected replacement. */
test("unknown and modified output files are not overwritten", (t) => {
  const parent = fixture(t);
  const unknown = path.join(parent, "unknown");
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, "user.txt"), "Keep this example fixture");
  assert.throws(
    () => writeGeneratedResources(unknown, { "NOTICE.txt": Buffer.from("new") }),
    /unowned files/,
  );
  assert.equal(
    fs.readFileSync(path.join(unknown, "user.txt"), "utf8"),
    "Keep this example fixture",
  );
  const edited = path.join(parent, "edited");
  writeGeneratedResources(edited, { "NOTICE.txt": Buffer.from("original") });
  fs.writeFileSync(path.join(edited, "NOTICE.txt"), "user edit");
  assert.throws(
    () => writeGeneratedResources(edited, { "NOTICE.txt": Buffer.from("replacement") }),
    /digest mismatch/,
  );
  assert.equal(fs.readFileSync(path.join(edited, "NOTICE.txt"), "utf8"), "user edit");
});

/** Generated paths cannot write outside the isolated resource directory. */
test("resource paths reject directory traversal", (t) => {
  const parent = fixture(t);
  assert.throws(
    () =>
      writeGeneratedResources(path.join(parent, "output"), {
        "../outside.txt": Buffer.from("invalid"),
      }),
    /Invalid generated license path/,
  );
  assert.equal(fs.existsSync(path.join(parent, "outside.txt")), false);
});

/** License overlays retain manual resources and contain no machine-specific source paths. */
test("the bundle overlay preserves existing resources using relative paths", () => {
  const overlay = createResourceOverlay({
    bundle: { resources: { "../docs/user-manual.html": "help/user-manual.html" } },
  });
  assert.deepEqual(overlay, {
    bundle: {
      resources: {
        "../docs/user-manual.html": "help/user-manual.html",
        "target/third-party-licenses/": "licenses/",
      },
    },
  });
  for (const [source, destination] of Object.entries(overlay.bundle.resources)) {
    assert.equal(path.isAbsolute(source), false);
    assert.equal(path.isAbsolute(destination), false);
  }
  assert.throws(
    () =>
      createResourceOverlay({ bundle: { resources: { [path.resolve("fixture")]: "licenses/" } } }),
    /relative paths/,
  );
});

/** A notice index alone does not replace the original per-package license files. */
test("the NSIS file list must carry every generated license resource", () => {
  const notice = '  File /a "/oname=licenses\\NOTICE.txt" "example-notice.txt"';
  const license =
    '  File /a "/oname=licenses\\cargo\\example-1.0.0\\LICENSE" "example-license.txt"';
  const files = ["NOTICE.txt", "cargo/example-1.0.0/LICENSE"];
  assert.throws(
    () => verifyNoticeInstallEntries(notice, files),
    /does not install license resource/,
  );
  assert.doesNotThrow(() => verifyNoticeInstallEntries(`${notice}\n${license}`, files));
});
