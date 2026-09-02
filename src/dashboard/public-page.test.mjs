import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../dashboard/styles.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
const controlClient = fs.readFileSync(new URL("../../dashboard/control-client.mjs", import.meta.url), "utf8");

test("public explainer is the default layer with clean product routes", () => {
  assert.match(html, /data-page="landing"/);
  assert.match(html, /href="\/app"/);
  assert.match(html, /href="\/proof"/);
  assert.match(html, /Become a DreamDEX liquidity provider without giving up custody of your capital/);
  assert.match(html, /For liquidity providers and operators/i);
  assert.match(html, /View verified replay/);
  assert.match(html, /id="how-it-works"/);
  assert.match(html, /THE OPERATOR PROBLEM/);
  assert.match(html, /WHAT VILLA DOES/);
  assert.match(html, /WHY DREAMDEX BENEFITS/);
  assert.match(html, /RISK AND SAFETY/);
  assert.match(html, /Enter operator console/);
  assert.doesNotMatch(app, /params\.get\("mode"\)/);
});

test("LP workspace is a simple owner-scoped onboarding flow", () => {
  assert.match(html, /data-page="app"[^>]*hidden/);
  assert.match(html, /MY LIQUIDITY/);
  assert.match(html, /Connect wallet/);
  assert.match(html, /Create VILLA account/);
  assert.match(html, /Add liquidity<\/button>/);
  assert.match(html, /Authorize VILLA/);
  assert.match(html, /Revoke VILLA/);
  assert.match(html, /Start strategy<\/button>/);
  assert.match(html, /Withdraw<\/button>/);
  assert.match(html, /VILLA never asks for your private key/);
  assert.match(html, /Your liquidity is held by this account/);
  assert.match(html, /id="start-villa"[^>]*disabled/);
  assert.match(html, /id="testnet-help"/);
  assert.match(html, /01 Connect/);
  assert.match(html, /06 Start/);
  assert.match(html, /SAFE CONTROL PLANE/);
});

test("proof is separate and reads replay data without control-plane calls", () => {
  assert.match(html, /data-page="proof"[^>]*hidden/);
  assert.match(html, /VERIFIED SHANNON REPLAY/);
  assert.match(html, /ACCOUNT-BOUND WET PROOF VERIFIED/);
  assert.match(html, /Canonical account-bound proof/);
  assert.match(html, /id="proof-scene"/);
  assert.match(app, /api\/snapshot\?mode=replay/);
  assert.doesNotMatch(app, /auth\/nonce|auth\/verify|VILLA_ENGINE_API_URL/);
  assert.match(controlClient, /account\/auth\/nonce/);
  assert.match(controlClient, /account\/session\/\$\{action\}/);
});

test("visual system is light, blue, responsive, and accessible", () => {
  assert.match(css, /color-scheme: light/);
  assert.match(css, /--blue:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.match(css, /max-width: 440px/);
  assert.match(css, /radial-gradient/);
  assert.match(css, /linear-gradient/);
  assert.doesNotMatch(css, /backdrop-filter/);
});
