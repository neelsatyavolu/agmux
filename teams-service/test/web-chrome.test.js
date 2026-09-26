import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

const { api } = vi.hoisted(() => ({ api: { me: vi.fn(), listTeams: vi.fn() } }));
vi.mock("../web/api.js", async original => ({ ...await original(), api }));
vi.mock("../web/devbar.js", () => ({ mountDevBar: vi.fn() }));
let dom;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});

async function boot(url, user) {
  vi.resetModules();
  vi.clearAllMocks();
  if (user) api.me.mockResolvedValue({ user });
  else api.me.mockRejectedValue(new Error("401"));
  api.listTeams.mockResolvedValue({ teams: [] });
  dom = new JSDOM('<div id="chrome"></div><main id="app"></main>', { url });
  for (const key of ["window", "document", "location", "history", "localStorage"]) vi.stubGlobal(key, dom.window[key]);
  await import("../web/app.js");
  return dom.window.document;
}

const user = { id: "user", display_name: "Test User", avatar_color: "#abcdef" };

it.each(["https://teams.test/", "https://teams.test/#/", "https://teams.test/#/teams"])(
  "a signed-in user with no teams can sign out from %s",
  async url => {
    const document = await boot(url, user);
    expect(document.querySelector("#app").textContent).toContain("No teams yet");
    expect(document.querySelector("#chrome").hidden).toBe(false);
    expect(document.querySelector("#signOut")).not.toBeNull();
  },
);

it("a signed-out visitor gets the landing page without the signed-in bar", async () => {
  const document = await boot("https://teams.test/", null);
  expect(document.querySelector("#chrome").hidden).toBe(true);
  expect(document.querySelector("#signOut")).toBeNull();
});
