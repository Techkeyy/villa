import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCOVERY_STATES,
  WALLET_STATES,
  deriveWalletStatus,
  renderAccountJourney,
} from "../../dashboard/account-journey.mjs";

const ACCOUNT_PANELS = ["account-loading", "account-empty", "account-workspace", "account-error"];
const JOURNEY_IDS = ["wallet-disconnected", "wallet-connected", "wrong-network", ...ACCOUNT_PANELS, "transaction-panel"];

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
    const ids = [...JOURNEY_IDS, "wallet-address", "network-status", "wallet-state", "account-error-title", "account-error-copy", "switch-network", "retry-account", "create-account"];
    this.elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  }

  getElementById(id) {
    return this.elements.get(id);
  }
}

function visible(document, ids = ACCOUNT_PANELS) {
  return ids.filter((id) => !document.getElementById(id).hidden);
}

function assertJourneyInvariant(document) {
  const panels = visible(document);
  assert.ok(panels.length <= 1, `at most one account panel may be visible: ${panels.join(", ")}`);
  return panels;
}

const baseState = {
  walletStatus: "DISCONNECTED",
  chainStatus: "UNKNOWN",
  discoveryStatus: "IDLE",
  account: null,
  transactionStatus: "IDLE",
  owner: "",
  chainId: null,
  error: null,
  busy: false,
};

test("canonical state and wallet derivation are explicit", () => {
  assert.deepEqual(DISCOVERY_STATES, ["IDLE", "DISCOVERING", "NO_ACCOUNT", "DISCOVERED", "DISCOVERY_ERROR", "SECURITY_ERROR"]);
  assert.deepEqual(WALLET_STATES, ["DISCONNECTED", "CONNECTED_WRONG_NETWORK", "CONNECTED_DISCOVERING", "CONNECTED_NO_ACCOUNT", "CONNECTED_ACCOUNT", "CONNECTED_ERROR", "CONNECTED_SECURITY_ERROR"]);
  assert.equal(deriveWalletStatus({ owner: "", chainStatus: "SHANNON", discoveryStatus: "DISCOVERED" }), "DISCONNECTED");
  assert.equal(deriveWalletStatus({ owner: "0xowner", chainStatus: "WRONG_NETWORK" }), "CONNECTED_WRONG_NETWORK");
  assert.equal(deriveWalletStatus({ owner: "0xowner", chainStatus: "SHANNON", discoveryStatus: "NO_ACCOUNT" }), "CONNECTED_NO_ACCOUNT");
  assert.equal(deriveWalletStatus({ owner: "0xowner", chainStatus: "SHANNON", discoveryStatus: "DISCOVERED" }), "CONNECTED_ACCOUNT");
  assert.equal(deriveWalletStatus({ owner: "0xowner", chainStatus: "SHANNON", discoveryStatus: "DISCOVERY_ERROR" }), "CONNECTED_ERROR");
  assert.equal(deriveWalletStatus({ owner: "0xowner", chainStatus: "SHANNON", discoveryStatus: "SECURITY_ERROR" }), "CONNECTED_SECURITY_ERROR");
});

test("every supported discovery state has one canonical visible account surface", () => {
  const expected = {
    IDLE: [],
    DISCOVERING: ["account-loading"],
    NO_ACCOUNT: ["account-empty"],
    DISCOVERED: ["account-workspace"],
    DISCOVERY_ERROR: ["account-error"],
    SECURITY_ERROR: ["account-error"],
  };

  for (const [discoveryStatus, panels] of Object.entries(expected)) {
    const document = new FakeDocument();
    const view = renderAccountJourney(document, {
      ...baseState,
      owner: "0x1111111111111111111111111111111111111111",
      chainStatus: "SHANNON",
      discoveryStatus,
      account: discoveryStatus === "DISCOVERED" ? { address: "0xaccount" } : null,
    });
    assert.deepEqual(assertJourneyInvariant(document), panels, discoveryStatus);
    assert.equal(view.discoveryState, discoveryStatus);
    assert.equal(document.getElementById("create-account").disabled, discoveryStatus !== "NO_ACCOUNT");
    assert.equal(document.getElementById("retry-account").disabled, !["DISCOVERY_ERROR", "SECURITY_ERROR"].includes(discoveryStatus));
    if (discoveryStatus === "SECURITY_ERROR") {
      assert.equal(document.getElementById("account-error-title").textContent, "Account verification blocked");
      assert.match(document.getElementById("account-error-copy").textContent, /could not verify it as a valid VILLA account/);
    }
    assert.equal(document.getElementById("wallet-connected").hidden, false);
    assert.equal(document.getElementById("wallet-disconnected").hidden, true);
  }
});

test("wrong network owns the action and prevents discovery surfaces", () => {
  const document = new FakeDocument();
  const view = renderAccountJourney(document, {
    ...baseState,
    owner: "0x1111111111111111111111111111111111111111",
    chainStatus: "WRONG_NETWORK",
    discoveryStatus: "DISCOVERING",
  });
  assert.equal(view.walletStatus, "CONNECTED_WRONG_NETWORK");
  assert.deepEqual(visible(document, ["wallet-disconnected", "wallet-connected", "wrong-network"]), ["wallet-connected", "wrong-network"]);
  assert.deepEqual(assertJourneyInvariant(document), []);
  assert.equal(document.getElementById("switch-network").disabled, false);
  assert.equal(document.getElementById("create-account").disabled, true);
});

test("full owner onboarding transition ends in stable no-account UI", () => {
  const document = new FakeDocument();
  const owner = "0x1111111111111111111111111111111111111111";

  renderAccountJourney(document, baseState);
  assert.deepEqual(visible(document, ["wallet-disconnected", "wallet-connected", "wrong-network"]), ["wallet-disconnected"]);

  renderAccountJourney(document, { ...baseState, owner, chainStatus: "WRONG_NETWORK" });
  assert.deepEqual(assertJourneyInvariant(document), []);

  renderAccountJourney(document, { ...baseState, owner, chainStatus: "SHANNON", discoveryStatus: "DISCOVERING" });
  assert.deepEqual(assertJourneyInvariant(document), ["account-loading"]);

  renderAccountJourney(document, { ...baseState, owner, chainStatus: "SHANNON", discoveryStatus: "NO_ACCOUNT" });
  assert.deepEqual(assertJourneyInvariant(document), ["account-empty"]);
  assert.equal(document.getElementById("account-loading").hidden, true);
  assert.equal(document.getElementById("account-empty").hidden, false);
  assert.equal(document.getElementById("create-account").disabled, false);
  assert.deepEqual(visible(document, ["wallet-disconnected", "wallet-connected", "wrong-network"]), ["wallet-connected"]);
});

test("refresh and chainChanged transitions clear the previous panel before rediscovery", () => {
  const document = new FakeDocument();
  const owner = "0x1111111111111111111111111111111111111111";
  const state = { ...baseState, owner, chainStatus: "SHANNON" };

  renderAccountJourney(document, { ...state, discoveryStatus: "NO_ACCOUNT" });
  renderAccountJourney(document, { ...state, discoveryStatus: "DISCOVERING" });
  assert.deepEqual(assertJourneyInvariant(document), ["account-loading"]);
  renderAccountJourney(document, { ...state, discoveryStatus: "NO_ACCOUNT" });
  assert.deepEqual(assertJourneyInvariant(document), ["account-empty"]);

  renderAccountJourney(document, { ...state, chainStatus: "WRONG_NETWORK", discoveryStatus: "NO_ACCOUNT" });
  assert.deepEqual(assertJourneyInvariant(document), []);
  renderAccountJourney(document, { ...state, discoveryStatus: "DISCOVERING" });
  assert.deepEqual(assertJourneyInvariant(document), ["account-loading"]);
  renderAccountJourney(document, { ...state, discoveryStatus: "NO_ACCOUNT" });
  assert.deepEqual(assertJourneyInvariant(document), ["account-empty"]);
});

test("renderer fails closed for invalid status and keeps all account surfaces mutually exclusive", () => {
  const document = new FakeDocument();
  const view = renderAccountJourney(document, {
    ...baseState,
    owner: "0x1111111111111111111111111111111111111111",
    chainStatus: "SHANNON",
    discoveryStatus: "UNKNOWN",
  });
  assert.equal(view.discoveryState, "IDLE");
  assert.deepEqual(assertJourneyInvariant(document), []);
});
