import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import os from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dashboard = path.join(root, "dashboard");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function countExact(text, value) {
  return text.split(value).length - 1;
}

async function startDashboardServer() {
  const port = 43000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["scripts/dashboard-server.mjs", "--replay", `--port=${port}`], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dashboard server did not start: ${output.join("")}`)), 15000);
    child.stdout.on("data", (chunk) => {
      output.push(String(chunk));
      if (String(chunk).includes("VILLA dashboard listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`dashboard server exited ${code}: ${output.join("")}`));
      }
    });
  });
  await ready;
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function startFixtureServer(body) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function runDashboardBuild() {
  const child = spawn(process.execPath, ["scripts/dashboard-build.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("dashboard build failed with " + code + ": " + output)));
  });
}

async function startBuiltDashboardServer() {
  const builtRoot = path.join(root, "dist", "dashboard");
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/snapshot") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ snapshot: {}, evidence: {}, source: "route-runtime-test" }));
      return;
    }
    const relative = pathname === "/" ? "index.html"
      : pathname === "/app" || pathname === "/app/" ? path.join("app", "index.html")
        : pathname === "/proof" || pathname === "/proof/" ? path.join("proof", "index.html")
          : pathname.replace(/^\/+/, "");
    const file = path.resolve(builtRoot, relative);
    if (!file.startsWith(builtRoot + path.sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, baseUrl: "http://127.0.0.1:" + address.port };
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.VILLA_BROWSER_BIN,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // Try the next known browser location.
    }
  }
  return null;
}

async function waitForJson(url, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(750) });
      if (response.ok) {
        const value = await response.json();
        if (predicate(value)) return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

async function removeTemporaryDirectory(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.open = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out opening the browser DevTools connection")), 10000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", (error) => {
        clearTimeout(timer);
        reject(error);
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.events.push(message);
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.open;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser DevTools method ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }
}

async function startHeadlessBrowser(url) {
  assert.equal(typeof WebSocket, "function", "Node WebSocket support is required for the browser runtime gate");
  const browser = await findBrowserExecutable();
  assert.ok(browser, "A Chrome-compatible browser is required for the computed-style runtime gate");
  const debugPort = 44000 + Math.floor(Math.random() * 1000);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "villa-dashboard-chrome-"));
  let child;
  try {
    child = spawn(browser, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      url,
    ], { stdio: "ignore" });
    const version = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/version`,
      (value) => Boolean(value.Browser && value.webSocketDebuggerUrl),
    );
    const page = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      (targets) => targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl),
    ).then((targets) => targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl));
    const cdp = new CdpClient(page.webSocketDebuggerUrl);
    const browserCdp = new CdpClient(version.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await browserCdp.send("Browser.getVersion");
    return {
      child,
      cdp,
      async close() {
        try {
          await browserCdp.send("Browser.close");
        } catch {
          // The browser may close the DevTools socket before acknowledging the command.
        }
        cdp.close();
        browserCdp.close();
        child.kill();
        await removeTemporaryDirectory(userDataDir);
      },
    };
  } catch (error) {
    child?.kill();
    await removeTemporaryDirectory(userDataDir);
    throw error;
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result?.value;
}

async function evaluateEventually(cdp, expression, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await evaluate(cdp, expression);
    } catch (error) {
      lastError = error;
      if (!/context was destroyed|target crashed/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

function ownerFixturePreload(artifact) {
  const fixture = JSON.stringify({
    owner: "0xCc67779F8eDb2C80DC665775C5597657C512FE1A".toLowerCase(),
    account: "0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b".toLowerCase(),
    zero: "0x0000000000000000000000000000000000000000",
    collateralToken: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E".toLowerCase(),
    outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9".toLowerCase(),
    binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388".toLowerCase(),
    binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23".toLowerCase(),
    runtimeBytecode: artifact.runtimeBytecode,
    selectors: {
      owner: "0x8da5cb5b",
      operator: "0x570ca735",
      autonomousTradingEnabled: "0x015d0803",
      collateralToken: "0xb2016bd4",
      outcomeToken: "0xa998d6d8",
      binaryModule: "0x36e5d64f",
      binarySettlement: "0x1f2ef0c7",
      balanceOf: "0x70a08231",
      allowance: "0xdd62ed3e",
    },
  });
  return [
    "(function () {",
    "const fixture = " + fixture + ";",
    "const originalFetch = window.fetch.bind(window);",
    "window.fetch = async (input, init) => {",
    "  const url = typeof input === 'string' ? input : input?.url || '';",
    "  if (url.startsWith('https://shannon-explorer.somnia.network/api')) return new Response(JSON.stringify({ status: '1', message: 'OK', result: [{ address: fixture.account }] }), { status: 200, headers: { 'content-type': 'application/json' } });",
    "  return originalFetch(input, init);",
    "};",
    "const requests = [];",
    "const addressWord = (value) => '0x' + '0'.repeat(24) + value.slice(2).toLowerCase();",
    "const uint = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');",
    "window.ethereum = {",
    "  request: async ({ method, params = [] }) => {",
    "    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [fixture.owner];",
    "    if (method === 'eth_chainId') return '0xc488';",
    "    if (method === 'eth_getCode') return fixture.runtimeBytecode;",
    "    if (method === 'eth_call') {",
    "      const data = String(params[0]?.data || '').toLowerCase();",
    "      const selector = data.slice(0, 10);",
    "      const target = '0x' + data.slice(-40);",
    "      if (selector === fixture.selectors.owner) return addressWord(fixture.owner);",
    "      if (selector === fixture.selectors.operator) return addressWord(fixture.zero);",
    "      if (selector === fixture.selectors.autonomousTradingEnabled) return uint(1);",
    "      if (selector === fixture.selectors.collateralToken) return addressWord(fixture.collateralToken);",
    "      if (selector === fixture.selectors.outcomeToken) return addressWord(fixture.outcomeToken);",
    "      if (selector === fixture.selectors.binaryModule) return addressWord(fixture.binaryModule);",
    "      if (selector === fixture.selectors.binarySettlement) return addressWord(fixture.binarySettlement);",
    "      if (selector === fixture.selectors.balanceOf) return uint(target === fixture.owner ? 500000000 : 0);",
    "      if (selector === fixture.selectors.allowance) return uint(0);",
    "      throw new Error('Unexpected fixture eth_call selector: ' + selector);",
    "    }",
    "    if (method === 'eth_sendTransaction') {",
    "      requests.push({ method, transaction: params[0] });",
    "      throw new Error('TEST_NO_BROADCAST');",
    "    }",
    "    throw new Error('Unexpected fixture wallet method: ' + method);",
    "  },",
    "  on: () => {},",
    "  removeListener: () => {},",
    "};",
    "window.__VILLA_OWNER_FIXTURE__ = { requests };",
    "})();",
  ].join("\n");
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = true;
    this.disabled = false;
    this.dataset = {};
    this.textContent = "";
    this.className = "";
  }

  toggleAttribute(name, force) {
    if (name === "hidden") this.hidden = Boolean(force);
  }
}

class FakeDocument {
  constructor() {
    const ids = [
      "wallet-disconnected",
      "wallet-connected",
      "wrong-network",
      "account-loading",
      "account-empty",
      "account-workspace",
      "account-error",
      "transaction-panel",
      "wallet-address",
      "network-status",
      "wallet-state",
      "switch-network",
      "retry-account",
      "create-account",
    ];
    this.elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  }

  getElementById(id) {
    return this.elements.get(id);
  }
}

test("dashboard server serves current source assets and the v2 build marker", async () => {
  const { child, baseUrl } = await startDashboardServer();
  try {
    const assets = [
      ["/app", "index.html"],
      ["/app.mjs", "app.mjs"],
      ["/account-journey.mjs", "account-journey.mjs"],
      ["/control-client.mjs", "control-client.mjs"],
    ];
    for (const [url, file] of assets) {
      const response = await fetch(`${baseUrl}${url}`);
      const served = Buffer.from(await response.arrayBuffer());
      const source = await fs.readFile(path.join(dashboard, file));
      assert.equal(response.status, 200, url);
      assert.equal(sha256(served), sha256(source), `${url} must match ${file}`);
      assert.deepEqual([...served], [...source], `${url} must be byte-identical to ${file}`);
    }

    const app = await (await fetch(`${baseUrl}/app.mjs`)).text();
    assert.match(app, /__VILLA_BUILD__/);
    assert.match(app, /account-journey-v2/);
    assert.match(app, /account-bound-release-v1/);
    assert.match(app, /renderAccountJourney/);
  } finally {
    child.kill();
  }
});

test("built landing, app, and proof routes initialize the intended runtime page", async () => {
  await runDashboardBuild();
  const { server, baseUrl } = await startBuiltDashboardServer();
  const expected = [
    ["/", "landing"],
    ["/app", "app"],
    ["/proof", "proof"],
    ];
  try {
    for (const [route, page] of expected) {
      const browser = await startHeadlessBrowser(baseUrl + route);
      try {
        await browser.cdp.send("Page.enable");
        await browser.cdp.send("Page.reload", { ignoreCache: true });
        const expression = [
          "(async () => {",
          "  const deadline = Date.now() + 5000;",
          "  while (Date.now() < deadline) {",
          "    if (document.body?.dataset?.page === " + JSON.stringify(page) + ") {",
          "      return {",
          "        page: document.body?.dataset?.page,",
          "        landingHidden: document.querySelector('.page-landing')?.hidden ?? null,",
          "        appHidden: document.querySelector('.page-app')?.hidden ?? null,",
          "        proofHidden: document.querySelector('.page-proof')?.hidden ?? null,",
          "        appCopy: document.querySelector('.page-app')?.textContent.includes('MY LIQUIDITY') ?? false,",
          "      };",
          "    }",
          "    await new Promise((resolve) => setTimeout(resolve, 25));",
          "  }",
          "  throw new Error('runtime page did not settle at ' + location.pathname + ' route=' + document.body?.dataset?.route + ' page=' + document.body?.dataset?.page);",
          "})()",
        ].join("\n");
        let state;
        try {
          state = await evaluateEventually(browser.cdp, expression);
        } catch (error) {
          throw new Error(error.message + " diagnostics=" + JSON.stringify(browser.cdp.events.slice(-8)));
        }
        assert.equal(state.page, page, route);
        assert.equal(state.landingHidden, page !== "landing", route);
        assert.equal(state.appHidden, page !== "app", route);
        assert.equal(state.proofHidden, page !== "proof", route);
        if (page === "app") assert.equal(state.appCopy, true);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("served HTML has unique fail-closed account panels and no duplicate legacy copy", async () => {
  const { child, baseUrl } = await startDashboardServer();
  try {
    const html = await (await fetch(`${baseUrl}/app`)).text();
    const app = await (await fetch(`${baseUrl}/app.mjs`)).text();
    const journey = await (await fetch(`${baseUrl}/account-journey.mjs`)).text();
    const css = await (await fetch(`${baseUrl}/styles.css`)).text();
    const servedDashboard = `${html}\n${app}\n${journey}`;
    assert.equal(countExact(html, '<script type="module" src="/app.mjs"></script>'), 1, "app bootstrap must be unique");
    for (const id of ["account-loading", "account-empty", "account-workspace", "account-error"]) {
      assert.equal(countExact(html, `id="${id}"`), 1, `${id} must be unique`);
      const openingTag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0] || "";
      assert.match(openingTag, /\bhidden\b/, `${id} must begin hidden in static HTML`);
    }
    assert.equal(countExact(servedDashboard, "Checking your VILLA account"), 1);
    assert.equal(countExact(servedDashboard, "No liquidity account yet."), 1);
    assert.doesNotMatch(css, /#account-(loading|empty|workspace|error)\s*\{[^}]*display\s*:/s);
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    assert.doesNotMatch(app, /toggle\("(account-loading|account-empty|account-workspace|account-error)"/);
    assert.match(journey, /toggleAttribute\("hidden"/);
  } finally {
    child.kill();
  }
});

test("real browser computed styles keep hidden journey panels out of layout", async () => {
  const { child: server, baseUrl } = await startDashboardServer();
  const css = await (await fetch(`${baseUrl}/styles.css`)).text();
  const journey = await (await fetch(`${baseUrl}/account-journey.mjs`)).text();
  const fixture = `<!doctype html>
    <html><head><meta charset="utf-8"><style>${css}</style></head>
    <body>
      <div id="wallet-disconnected"></div>
      <div id="wallet-connected"></div>
      <div id="wrong-network"></div>
      <div id="account-loading" class="panel loading-panel" hidden><span class="spinner"></span><p>Checking your VILLA account</p></div>
      <div id="account-empty" class="panel account-empty" hidden><p>No liquidity account yet.</p></div>
      <div id="account-workspace" class="panel" hidden></div>
      <div id="account-error" class="panel" hidden></div>
      <div id="transaction-panel" hidden></div>
      <span id="wallet-address"></span><span id="network-status"></span><span id="wallet-state"></span>
      <button id="switch-network"></button><button id="retry-account"></button><button id="create-account"></button>
      <script type="module">${journey}
        window.__VILLA_RENDER_ACCOUNT_JOURNEY__ = renderAccountJourney;
      </script>
    </body></html>`;
  const fixtureServer = await startFixtureServer(fixture);
  let browser;
  try {
    browser = await startHeadlessBrowser(fixtureServer.url);
    await evaluateEventually(browser.cdp, `
      (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (typeof window.__VILLA_RENDER_ACCOUNT_JOURNEY__ === "function") return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("served journey renderer did not load");
      })()
    `);
    const states = await evaluateEventually(browser.cdp, `
      (async () => {
        const renderAccountJourney = window.__VILLA_RENDER_ACCOUNT_JOURNEY__;
        const ids = ["account-loading", "account-empty", "account-workspace", "account-error"];
        const output = {};
        for (const discoveryStatus of ["DISCOVERING", "NO_ACCOUNT", "DISCOVERED", "DISCOVERY_ERROR", "SECURITY_ERROR"]) {
          renderAccountJourney(document, {
            walletStatus: "CONNECTED_DISCOVERING",
            chainStatus: "SHANNON",
            discoveryStatus,
            account: discoveryStatus === "DISCOVERED" ? { address: "0xaccount" } : null,
            transactionStatus: "IDLE",
            owner: "0x1111111111111111111111111111111111111111",
            chainId: 50312,
            error: ["DISCOVERY_ERROR", "SECURITY_ERROR"].includes(discoveryStatus) ? "retry" : null,
            busy: false,
          });
          output[discoveryStatus] = Object.fromEntries(ids.map((id) => {
            const element = document.getElementById(id);
            return [id, { hidden: element.hidden, display: getComputedStyle(element).display }];
          }));
        }
        return output;
      })()
    `);

    const expectedVisible = {
      DISCOVERING: "account-loading",
      NO_ACCOUNT: "account-empty",
      DISCOVERED: "account-workspace",
      DISCOVERY_ERROR: "account-error",
      SECURITY_ERROR: "account-error",
    };
    for (const [state, panels] of Object.entries(states)) {
      for (const [id, panel] of Object.entries(panels)) {
        if (id === expectedVisible[state]) {
          assert.equal(panel.hidden, false, `${state}: ${id} must be visible`);
          assert.notEqual(panel.display, "none", `${state}: ${id} must render`);
        } else {
          assert.equal(panel.hidden, true, `${state}: ${id} must be hidden`);
          assert.equal(panel.display, "none", `${state}: ${id} must have computed display:none`);
        }
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => fixtureServer.server.close(resolve));
    server.kill();
  }
});

test("served app keeps verified readiness through refresh and reaches both owner action preparation stages", async () => {
  const { child: server, baseUrl } = await startDashboardServer();
  const artifact = JSON.parse(await fs.readFile(path.join(dashboard, "villa-account-artifact.json"), "utf8"));
  let browser;
  try {
    browser = await startHeadlessBrowser(baseUrl + "/app");
    await browser.cdp.send("Page.enable");
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: ownerFixturePreload(artifact) });
    await browser.cdp.send("Page.reload", { ignoreCache: true });

    const waitForReady = async (minimumJobs = 1) => {
      const expression = [
        "(async () => {",
        "  const deadline = Date.now() + 8000;",
        "  while (Date.now() < deadline) {",
        "    const debug = window.__VILLA_READINESS_DEBUG__;",
        "    const jobs = window.__VILLA_DEBUG__?.events?.filter((event) => event.event === 'discovery_job_start').length || 0;",
        "    if (debug?.snapshot?.discovery === 'DISCOVERED'",
        "      && debug.snapshot.accountAddress === '0xfc9dbf0a8468aa56799b4e23b1ebe936426ee30b'",
        "      && debug.ready === true",
        "      && jobs >= " + minimumJobs + ") return debug;",
        "    await new Promise((resolve) => setTimeout(resolve, 25));",
        "  }",
        "  throw new Error('readiness did not settle: ' + JSON.stringify(window.__VILLA_READINESS_DEBUG__));",
        "})()",
      ].join("\n");
      return evaluateEventually(browser.cdp, expression, 60);
    };

    const discovered = await waitForReady(1);
    assert.equal(discovered.ready, true);
    assert.deepEqual(discovered.reasons, []);
    assert.equal(discovered.snapshot.wallet, "0xcc67779f8edb2c80dc665775c5597657c512fe1a");
    assert.equal(discovered.snapshot.accountOwner, discovered.snapshot.wallet);
    assert.equal(discovered.snapshot.accountCurrent, true);
    assert.equal(await evaluate(browser.cdp, "document.getElementById('capital-status').textContent"), "ACCOUNT READY");
    assert.equal(await evaluate(browser.cdp, "document.getElementById('add-liquidity').disabled"), false);
    assert.equal(await evaluate(browser.cdp, "document.getElementById('authorize-villa').hidden"), false);
    assert.doesNotMatch(await evaluate(browser.cdp, "document.getElementById('capital-message').textContent"), /not ready/i);

    await evaluate(browser.cdp, "document.getElementById('refresh-account').click(); true");
    const refreshed = await waitForReady(2);
    assert.equal(refreshed.ready, true);
    assert.equal(refreshed.snapshot.accountAddress, discovered.snapshot.accountAddress);
    assert.equal(refreshed.snapshot.accountOwner, discovered.snapshot.accountOwner);
    assert.equal(refreshed.snapshot.accountCurrent, true);
    assert.equal(await evaluate(browser.cdp, "document.getElementById('add-liquidity').disabled"), false);
    assert.equal(await evaluate(browser.cdp, "document.getElementById('authorize-villa').hidden"), false);

    await evaluate(browser.cdp, "const input = document.getElementById('amount-to-use'); input.value = '1.00'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('add-liquidity').click(); true");
    const addTrace = await evaluateEventually(browser.cdp, [
      "(async () => {",
      "  const deadline = Date.now() + 5000;",
      "  while (Date.now() < deadline) {",
      "    const events = window.__VILLA_LIQUIDITY_DEBUG__?.events || [];",
      "    const click = events.find((event) => event.event === 'add_liquidity_click');",
      "    if (events.some((event) => event.event === 'approval_request_start')) return { click, message: document.getElementById('capital-message').textContent };",
      "    await new Promise((resolve) => setTimeout(resolve, 25));",
      "  }",
      "  throw new Error('add-liquidity preparation did not start');",
      "})()",
    ].join("\n"), 60);
    assert.equal(addTrace.click.readiness.ready, true);
    assert.doesNotMatch(addTrace.message, /account is not ready/i);

    await evaluate(browser.cdp, "document.getElementById('authorize-villa').click(); true");
    const authorizationTrace = await evaluateEventually(browser.cdp, [
      "(async () => {",
      "  const deadline = Date.now() + 5000;",
      "  while (Date.now() < deadline) {",
      "    const events = window.__VILLA_AUTHORIZATION_DEBUG__?.events || [];",
      "    const click = events.find((event) => event.event === 'authorize_click');",
      "    if (events.some((event) => event.event === 'authorize_prepare')) return { click, message: document.getElementById('authorization-message').textContent };",
      "    await new Promise((resolve) => setTimeout(resolve, 25));",
      "  }",
      "  throw new Error('authorization preparation did not start');",
      "})()",
    ].join("\n"), 60);
    assert.equal(authorizationTrace.click.readiness.ready, true);
    assert.doesNotMatch(authorizationTrace.message, /account is not ready/i);

    const requests = await evaluate(browser.cdp, "window.__VILLA_OWNER_FIXTURE__.requests");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.method), ["eth_sendTransaction", "eth_sendTransaction"]);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
});

test("served account-journey module renders the real NO_ACCOUNT DOM state", async () => {
  const { child, baseUrl } = await startDashboardServer();
  try {
    const source = await (await fetch(`${baseUrl}/account-journey.mjs`)).text();
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const document = new FakeDocument();
    const result = module.renderAccountJourney(document, {
      walletStatus: "CONNECTED_NO_ACCOUNT",
      chainStatus: "SHANNON",
      discoveryStatus: "NO_ACCOUNT",
      account: null,
      transactionStatus: "IDLE",
      owner: "0x1111111111111111111111111111111111111111",
      chainId: 50312,
      error: null,
      busy: false,
    });
    assert.equal(result.discoveryState, "NO_ACCOUNT");
    assert.equal(document.getElementById("account-loading").hidden, true);
    assert.equal(document.getElementById("account-empty").hidden, false);
    assert.equal(document.getElementById("account-workspace").hidden, true);
    assert.equal(document.getElementById("account-error").hidden, true);
    assert.equal(document.getElementById("create-account").disabled, false);
  } finally {
    child.kill();
  }
});
