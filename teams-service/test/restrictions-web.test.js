import { expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { mountRestrictions, restrictionsLoading, restrictionsPanel } from "../web/views/restrictions.js";

vi.mock("../web/dom.js", async importOriginal => ({ ...await importOriginal(), icons: vi.fn() }));

const unrestricted = { allowedProviders: null, allowedModels: null, allowedModes: null, allowedEfforts: null };
const response = (extra = {}) => ({ enforcementVersion: 2, policy: { ...unrestricted }, editablePolicy: { ...unrestricted }, canManage: true, scopeLabel: "Platform · active employees and you only", ...extra });
function root() {
  return new JSDOM(restrictionsLoading()).window.document.querySelector("#restrictions");
}
function change(root, selector, checked) {
  const el = root.querySelector(selector);
  el.checked = checked;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event("input", { bubbles: true }));
}

it("renders organized, escaped, scoped restrictions and exact matching guidance", () => {
  const html = restrictionsPanel(response({ scopeLabel: '<img src=x onerror="bad()">', editablePolicy: { ...unrestricted, allowedModes: [], allowedModels: ["</textarea><script>bad()</script>"] } }));
  expect(html).toContain("Session modes");
  expect(html).toContain("Reasoning effort");
  expect(html).toContain("IDs are exact and case-sensitive.");
  expect(html).toContain("None selected — this layer denies all");
  expect(html).toContain("Review before saving");
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<script>');
  expect(html).toContain("does not stop running turns");
  expect(html).toContain("Cursor, OpenCode and Local MLX support model rules only");
  expect(html).toContain("local/&lt;id&gt;");
  expect(html).toContain("MLX is the only allowed agent");
});

it("keeps staff and employees disabled with no save action", async () => {
  const el = root();
  await mountRestrictions(el, { getPolicy: async () => response({ canManage: false, editablePolicy: null }) }, "team");
  expect(el.querySelector("fieldset").disabled).toBe(true);
  expect(el.querySelector('button[type="submit"]')).toBeNull();
});

it("shows load errors and rejects older contracts without an editable form", async () => {
  const el = root();
  const api = { getPolicy: vi.fn().mockResolvedValue({ policy: {} }) };
  await mountRestrictions(el, api, "team");
  expect(el.querySelector('[role="alert"]').textContent).toContain("updated Teams service");
  expect(el.querySelector("form")).toBeNull();
  api.getPolicy.mockResolvedValue(response());
  await el.querySelector("button").onclick();
  expect(el.querySelector("form")).not.toBeNull();
});

it("summarizes deny all before saving, prevents duplicate saves, and preserves errors/drafts", async () => {
  const el = root();
  let rejectSave;
  const api = { getPolicy: async () => response(), putPolicy: vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; })) };
  await mountRestrictions(el, api, "team");
  const form = el.querySelector("form"), button = el.querySelector('button[type="submit"]');
  expect(button.disabled).toBe(true);
  change(el, '[data-unrestricted="allowedModes"]', false);
  expect(button.disabled).toBe(false);
  expect(el.querySelector("[data-restrictions-summary]").textContent).toContain("Session modes: deny all");
  const pending = form.onsubmit({ preventDefault() {} });
  await form.onsubmit({ preventDefault() {} });
  expect(api.putPolicy).toHaveBeenCalledTimes(1);
  expect(api.putPolicy).toHaveBeenCalledWith("team", { ...unrestricted, allowedModes: [] });
  expect(button.disabled).toBe(true);
  rejectSave(new Error("Connection lost"));
  await pending;
  expect(button.disabled).toBe(false);
  expect(el.querySelector('[role="alert"]').textContent).toBe("Connection lost");
  api.putPolicy.mockResolvedValue(response({ editablePolicy: { ...unrestricted, allowedModes: [] }, policy: { ...unrestricted, allowedModes: [] } }));
  await form.onsubmit({ preventDefault() {} });
  expect(el.querySelector('button[type="submit"]').disabled).toBe(true);
  expect(el.textContent).toContain("Restrictions saved");
});

it("validates model duplicates and round-trips exact IDs with unrestricted toggles", async () => {
  const el = root();
  await mountRestrictions(el, { getPolicy: async () => response() }, "team");
  change(el, '[data-unrestricted="allowedModels"]', false);
  const input = el.querySelector("textarea");
  input.value = "vendor/model-v1\nvendor/model-v1";
  input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
  expect(el.querySelector('button[type="submit"]').disabled).toBe(true);
  input.value = "vendor/model-v1";
  input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
  expect(el.querySelector('button[type="submit"]').disabled).toBe(false);
  change(el, '[data-unrestricted="allowedModels"]', true);
  expect(input.disabled).toBe(true);
  expect(el.querySelector('button[type="submit"]').disabled).toBe(true);
});

it("offers every app provider and explains terminal incompatibility", () => {
  const el = root();
  el.innerHTML = restrictionsPanel(response({ editablePolicy: { ...unrestricted, allowedModels: ["exact-model"] } }));
  expect([...el.querySelectorAll('[data-choice="allowedProviders"]')].map(e => e.value).sort()).toEqual(["ClaudeCode", "Codex", "Grok", "Cursor", "Droid", "Pi", "Kimi", "Cline", "Gemini", "Hermes", "OpenCode", "MLX"].sort());
  expect(el.querySelector("[data-restrictions-summary]").textContent).toContain("Terminals unavailable");
  expect(el.textContent).toContain("even if Terminal is checked");
});

it("renders icons after the async panel has been inserted", async () => {
  const { icons } = await import("../web/dom.js");
  const el = root();
  icons.mockImplementationOnce(() => {
    expect(el.querySelector('[data-lucide="shield-check"]')).not.toBeNull();
    expect(el.querySelector("form")).not.toBeNull();
  });
  const calls = icons.mock.calls.length;
  await mountRestrictions(el, { getPolicy: async () => response() }, "team");
  expect(icons.mock.calls.length).toBe(calls + 1);
});
