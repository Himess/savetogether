import { expect } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The artifact screen has to be able to FAIL.
 *
 * `scripts/check-out-artifacts.mjs` is the thing standing between a future
 * `git add -A` and a published private key: `out/` holds live keys, and the
 * .gitignore allowlist is only as good as the screen that decides what goes on it.
 *
 * A screen that has only ever been run against files it passes is not a control —
 * it is a script that has never been tested. This runs it against a fixture shaped
 * exactly like the two real offenders and asserts it says no.
 */
describe("the artifact screen refuses key-shaped files", () => {
  const ROOT = path.resolve(__dirname, "..");
  const FIXTURE = path.join(ROOT, "test/fixtures/keys-that-must-be-rejected.json");

  it("rejects a bare 64-hex array and an arms[].pk field", () => {
    const staged = path.join(ROOT, "out", "__screen-fixture__.json");
    fs.copyFileSync(FIXTURE, staged);
    try {
      const out = execFileSync("node", ["scripts/check-out-artifacts.mjs"], {
        cwd: ROOT, encoding: "utf8",
      });
      const line = out.split("\n").find((l) => l.includes("__screen-fixture__"));
      expect(line, "the screen must say something about the fixture").to.not.be.undefined;
      expect(line, "the fixture must be SKIPped, never cleared").to.match(/SKIP/);
      expect(out, "and it must not appear in the cleared list").to.not.match(
        /cleared to commit[\s\S]*__screen-fixture__/,
      );
    } finally {
      fs.rmSync(staged, { force: true });
    }
  });

  it("still clears an ordinary evidence artifact", () => {
    const out = execFileSync("node", ["scripts/check-out-artifacts.mjs"], {
      cwd: ROOT, encoding: "utf8",
    });
    expect(out).to.match(/\d+ artifact\(s\) cleared to commit/);
    expect(out, "the two real key files must always be skipped").to.match(/SKIP \(holds keys\)\s+arms-c\.json/);
    expect(out).to.match(/SKIP \(holds keys\)\s+demo-participants\.json/);
  });
});
