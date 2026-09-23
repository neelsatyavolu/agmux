import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

const { api } = vi.hoisted(() => ({ api: {
  me: vi.fn(), listTeams: vi.fn(), getTeam: vi.fn(), getPolicy: vi.fn(),
  members: vi.fn(), groups: vi.fn(), managerScopes: vi.fn(), getInvite: vi.fn(),
} }));
vi.mock("../web/api.js", async original => ({ ...await original(), api }));
vi.mock("../web/devbar.js", () => ({ mountDevBar: vi.fn() }));
let dom;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});

it.each(["owner", "manager", "employee", "staff"])("loads the direct restrictions route as %s without roster dependencies", async role => {
  vi.resetModules();
  vi.clearAllMocks();
  const staffPreview = role === "staff";
  const membershipRole = staffPreview ? "manager" : role;
  const canManage = role === "owner" || role === "manager";
  const team = { id: "team", slug: "team", name: "Platform <team>" };
  const policy = { teamId: "team", allowedModes: null, allowedEfforts: null, allowedProviders: null, allowedModels: null };
  api.me.mockResolvedValue({ user: { id: "user", display_name: "Test User", avatar_color: "#abcdef" } });
  api.listTeams.mockResolvedValue({ teams: [{ ...team, role: membershipRole, staffPreview }] });
  api.getTeam.mockResolvedValue({ team, role: membershipRole, staffPreview });
  api.getPolicy.mockResolvedValue({ enforcementVersion: 2, policy, editablePolicy: canManage ? policy : null, canManage, scopeLabel: staffPreview ? "Staff preview · read only" : "Entire team" });
  dom = new JSDOM('<div id="chrome"></div><main id="app"></main>', { url: "https://teams.test/#/t/team/restrictions" });
  for (const key of ["window", "document", "location", "history", "localStorage"]) vi.stubGlobal(key, dom.window[key]);
  await import("../web/app.js");
  const document = dom.window.document;
  expect(document.querySelector("h1").textContent).toBe("Restrictions");
  expect(document.querySelector(".restrictions-page .meta").textContent).toBe(team.name);
  expect(document.querySelector(".restrictions-page .meta team")).toBeNull();
  const nav = document.querySelector('nav a[href="#/t/team/restrictions"]');
  expect(Boolean(nav)).toBe(canManage);
  if (nav) expect(nav.classList.contains("on")).toBe(true);
  expect(document.querySelector("fieldset").disabled).toBe(!canManage);
  expect(Boolean(document.querySelector('button[type="submit"]'))).toBe(canManage);
  expect(api.getTeam).toHaveBeenCalledExactlyOnceWith("team");
  expect(api.getPolicy).toHaveBeenCalledExactlyOnceWith("team");
  for (const name of ["members", "groups", "managerScopes", "getInvite"]) expect(api[name]).not.toHaveBeenCalled();

  // Re-entry replaces the delegated-event root; a delayed response cannot paint over navigation.
  const previousPage = document.querySelector("#app");
  const previousClick = vi.fn();
  previousPage.addEventListener("click", previousClick);
  let resolveTeam;
  api.getTeam.mockImplementationOnce(() => new Promise(resolve => { resolveTeam = resolve; }));
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  const loadingPage = document.querySelector("#app");
  expect(loadingPage).not.toBe(previousPage);
  expect(previousPage.isConnected).toBe(false);
  loadingPage.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  expect(previousClick).not.toHaveBeenCalled();
  dom.window.history.replaceState({}, "", "#/privacy");
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  const destination = document.querySelector("#app");
  const destinationMarkup = destination.innerHTML;
  expect(loadingPage.isConnected).toBe(false);
  resolveTeam({ team, role: membershipRole, staffPreview });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(destination.innerHTML).toBe(destinationMarkup);
  expect(api.getPolicy).toHaveBeenCalledTimes(1);

});
