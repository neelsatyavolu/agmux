import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync("remote-relay/public/app.html", "utf8");

function questionSheet() {
  document.body.innerHTML = html.slice(html.indexOf('      <div class="appr-scrim"'), html.indexOf('      <div class="phone-home"'));
  const send = vi.fn();
  const next = vi.fn();
  const api = new Function("document", "ws", "showNextPending", `
    let pendingApproval = null, pendingUserInput = null;
    const threads = [{ id: 'codex', provider: 'Codex' }, { id: 'oc', provider: 'OpenCode' }], set = () => {}, shortProvider = (p) => p;
    const showToast = () => {};
    ${html.slice(html.indexOf("function collectUserInputAnswers("), html.indexOf("// FIFO queue for concurrent approval"))}
    ${html.slice(html.indexOf("function showApprovalSheet("), html.indexOf("// Wire UI"))}
    return { showUserInputSheet, showApprovalSheet, respondApproval };
  `)(document, { readyState: 1, send }, next);
  return { ...api, send, next };
}

describe("phone agent questions", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("requires an answer and submits the selected option keyed by full question text", () => {
    const sheet = questionSheet();
    const question = "Which deployment region should we use?";
    sheet.showUserInputSheet({ threadId: "t", requestId: "r", questions: [{ header: "Region", question, options: [{ label: "East" }, { label: "West" }] }] });
    sheet.respondApproval("allow");
    expect(sheet.send).not.toHaveBeenCalled();
    const choices = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(choices.length).toBe(2);
    choices[1].click();
    sheet.respondApproval("allow");
    expect(JSON.parse(sheet.send.mock.calls[0][0])).toEqual({
      type: "userInput.respond", threadId: "t", requestId: "r", answers: { answers: { [question]: "West" } },
    });
  });

  it("collects multiple selections and free text without inventing defaults", () => {
    const sheet = questionSheet();
    sheet.showUserInputSheet({ threadId: "t", requestId: "r", questions: [
      { question: "Targets?", multiSelect: true, options: [{ label: "Web" }, { label: "iOS" }] },
      { question: "Anything else?", options: [] },
    ] });
    const choices = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(choices.length).toBe(2);
    choices.forEach((input) => input.click());
    const text = document.querySelectorAll<HTMLTextAreaElement>("textarea");
    text[1].value = "  Keep the existing name.  ";
    text[1].dispatchEvent(new Event("input", { bubbles: true }));
    sheet.respondApproval("allow");
    expect(JSON.parse(sheet.send.mock.calls[0][0]).answers).toEqual({ answers: { "Targets?": "Web, iOS", "Anything else?": "Keep the existing name." } });
  });

  it("uses Codex question IDs and answer arrays", () => {
    const sheet = questionSheet();
    sheet.showUserInputSheet({ threadId: "codex", requestId: "r", questions: [{ id: "region", question: "Where?", options: ["East", "West"] }] });
    document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click();
    sheet.respondApproval("allow");
    expect(JSON.parse(sheet.send.mock.calls[0][0]).answers).toEqual({ answers: { region: { answers: ["West"] } } });
  });

  it("keeps OpenCode multi-select answers as ordered arrays", () => {
    const sheet = questionSheet();
    sheet.showUserInputSheet({ threadId: "oc", requestId: "r", questions: [{ question: "Targets?", multiple: true, options: ["Web, desktop", "iOS"] }] });
    const choices = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(choices.length).toBe(2);
    choices.forEach((input) => input.click());
    sheet.respondApproval("allow");
    expect(JSON.parse(sheet.send.mock.calls[0][0]).answers).toEqual([["Web, desktop", "iOS"]]);
  });

  it("supports a custom answer to a choice question and clears controls for approvals", () => {
    const sheet = questionSheet();
    sheet.showUserInputSheet({ threadId: "t", requestId: "r", questions: [{ question: "Region?", options: ["East", "West"] }] });
    const text = document.querySelector<HTMLTextAreaElement>("textarea");
    expect(text).not.toBeNull();
    text!.value = "Europe";
    text!.dispatchEvent(new Event("input", { bubbles: true }));
    sheet.respondApproval("allow");
    expect(JSON.parse(sheet.send.mock.calls[0][0]).answers).toEqual({ answers: { "Region?": "Europe" } });
    sheet.showApprovalSheet({ toolName: "Read", detail: "file" });
    expect(document.querySelector("#apprQuestions")?.textContent).toBe("");
    expect(document.querySelector<HTMLButtonElement>("#allowBtn")?.disabled).toBe(false);
  });
});
