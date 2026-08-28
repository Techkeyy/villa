import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");

test("public product explainer is the default layer and cockpit is explicit", () => {
  assert.match(html, /<main class="landing-page" data-page="landing"/);
  assert.match(html, /<main class="workspace cockpit-page" data-page="cockpit"[^>]*hidden/);
  assert.match(html, /Enter operator console/);
  assert.match(html, /View verified replay/);
  assert.match(html, /id="how-it-works"/);
  assert.match(html, /id="proof"/);
  assert.match(app, /params\.get\("mode"\) === "operator" \? "operator" : params\.get\("mode"\) === "replay" \? "replay" : "landing"/);
});

test("explainer copy names the real LP product and avoids technical promises", () => {
  assert.match(html, /bounded liquidity operator for DreamDEX/);
  assert.match(html, /liquidity providers and operators, not retail bettors/);
  assert.match(html, /The safe answer is sometimes no quote/);
  assert.match(html, /VILLA does not promise profit/);
});
