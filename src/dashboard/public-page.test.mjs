import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../dashboard/styles.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");

test("public explainer is the default layer with clean product routes", () => {
  assert.match(html, /data-page="landing"/);
  assert.match(html, /href="\/app"/);
  assert.match(html, /href="\/proof"/);
  assert.match(html, /Put your capital to work as liquidity on DreamDEX Event Contracts/);
  assert.match(html, /For liquidity providers and operators/);
  assert.match(html, /View verified replay/);
  assert.match(html, /id="how-it-works"/);
  assert.doesNotMatch(app, /params\.get\("mode"\)/);
});

test("LP workspace is honest about development-gated capital actions", () => {
  assert.match(html, /data-page="app"[^>]*hidden/);
  assert.match(html, /MY LIQUIDITY/);
  assert.match(html, /Connect wallet/);
  assert.match(html, /Add liquidity<\/button>/);
  assert.match(html, /Start VILLA<\/button>/);
  assert.match(html, /Withdraw<\/button>/);
  assert.match(html, /Capital actions are not live yet/);
  assert.match(html, /VILLA will not ask for your private key/);
  assert.match(html, /No deposit or transaction is sent/);
  assert.match(html, /disabled>Add liquidity/);
  assert.match(html, /disabled>Start VILLA/);
  assert.match(html, /disabled>Withdraw/);
});

test("proof is separate and reads replay data without control-plane calls", () => {
  assert.match(html, /data-page="proof"[^>]*hidden/);
  assert.match(html, /VERIFIED SHANNON REPLAY/);
  assert.match(html, /id="proof-scene"/);
  assert.match(app, /api\/snapshot\?mode=replay/);
  assert.doesNotMatch(app, /auth\/nonce|auth\/verify|\/state|\/config|START|PAUSE|STOP/);
});

test("visual system is light, blue, responsive, and accessible", () => {
  assert.match(css, /color-scheme: light/);
  assert.match(css, /--blue:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.match(css, /max-width: 440px/);
  assert.doesNotMatch(css, /radial-gradient|linear-gradient|backdrop-filter/);
});
