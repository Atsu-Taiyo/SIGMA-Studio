import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
require("app-builder-lib");
const { validateConfiguration } = require("app-builder-lib/out/util/config/config");
const { MacTargetHelper } = require("app-builder-lib/out/mac/MacTargetHelper");
const configPath = require.resolve("../apps/desktop/electron-builder.config.cjs");
const keys = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "SIGMA_STUDIO_REQUIRE_MAC_SIGNING", "SIGMA_STUDIO_WINDOWS_STORE", "WINDOWS_STORE_IDENTITY_NAME", "WINDOWS_STORE_PUBLISHER", "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME"];
const signed = { CSC_LINK: "fixture.p12", CSC_KEY_PASSWORD: "fixture", APPLE_ID: "fixture@example.invalid", APPLE_APP_SPECIFIC_PASSWORD: "fixture", APPLE_TEAM_ID: "FIXTURETEAM", SIGMA_STUDIO_REQUIRE_MAC_SIGNING: "true" };
async function withEnvironment(values, run) {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) { delete process.env[key]; }
    Object.assign(process.env, values);
    delete require.cache[configPath];
    await run(() => require(configPath));
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    delete require.cache[configPath];
  }
}

for (const [name, env] of Object.entries({ unsigned: {}, signed, store: { SIGMA_STUDIO_WINDOWS_STORE: "true", WINDOWS_STORE_IDENTITY_NAME: "Fixture.App", WINDOWS_STORE_PUBLISHER: "CN=Fixture", WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: "Fixture" } })) {
  test(`the installed builder accepts the ${name} release configuration`, async () => {
    await withEnvironment(env, async load => {
      const config = load();
      await validateConfiguration(config, { isEnabled: false });
      assert.equal(config.mac.notarize, name === "signed");
      assert.equal(config.mac.hardenedRuntime, name === "signed");
      assert.equal(config.win.target, name === "store" ? "appx" : "nsis");
      if (name === "signed") {
        const options = MacTargetHelper.getNotarizeOptions("Fixture.app");
        assert.equal(options.teamId, signed.APPLE_TEAM_ID);
        assert.equal(options.appleId, signed.APPLE_ID);
      }
    });
  });
}
test("a public Mac release still requires a certificate and notarization credentials", async () => {
  await withEnvironment({ SIGMA_STUDIO_REQUIRE_MAC_SIGNING: "true" }, async load => {
    assert.throws(load, /requires CSC_LINK and CSC_KEY_PASSWORD/);
  });
  await withEnvironment({ ...signed, APPLE_TEAM_ID: "" }, async load => {
    assert.throws(load, /requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID/);
  });
});
