/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { JoinDisclosureDialog } from "../JoinDisclosureDialog";
import { NEVER_SHORT, SHARED_SHORT } from "../disclosureCopy";

afterEach(cleanup);

const setup = (over: Partial<Parameters<typeof JoinDisclosureDialog>[0]> = {}) => {
  const onAccept = vi.fn();
  const onCancel = vi.fn();
  render(
    <JoinDisclosureDialog
      teamName="Helios Platform"
      onAccept={onAccept}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onAccept, onCancel };
};

describe("JoinDisclosureDialog", () => {
  it("names the team being joined", () => {
    setup();
    expect(screen.getByText(/Join Helios Platform/)).toBeTruthy();
    expect(screen.getByText(/managers of Helios Platform/)).toBeTruthy();
  });

  it("shows both disclosure columns in full", () => {
    setup();
    for (const line of [...SHARED_SHORT, ...NEVER_SHORT]) {
      expect(screen.getByText(line)).toBeTruthy();
    }
  });

  it("discloses approval wait metrics but never stop rate", () => {
    setup();
    // Approval wait (blocked time) is intentionally shared; stop-rate is not.
    expect(screen.getByText(/Approval wait counts and total blocked time/i)).toBeTruthy();
    expect(screen.queryByText(/stop rate/i)).toBeNull();
  });

  it("keeps Accept disabled until the box is ticked", () => {
    const { onAccept } = setup();
    const accept = screen.getByRole("button", { name: /Accept & join/ }) as HTMLButtonElement;

    expect(accept.disabled).toBe(true);
    fireEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("re-disables Accept if the box is un-ticked", () => {
    setup();
    const accept = screen.getByRole("button", { name: /Accept & join/ }) as HTMLButtonElement;
    const box = screen.getByRole("checkbox");

    fireEvent.click(box);
    expect(accept.disabled).toBe(false);
    fireEvent.click(box);
    expect(accept.disabled).toBe(true);
  });

  it("starts unchecked — consent is never pre-granted", () => {
    setup();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  });

  it("lets the user back out without joining", () => {
    const { onCancel, onAccept } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Not now/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("blocks double-submit while the join is in flight", () => {
    setup({ busy: true });
    const accept = screen.getByRole("button", { name: /Joining…/ }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("checkbox"));
    expect(accept.disabled).toBe(true);
  });

  it("surfaces a join failure instead of silently closing", () => {
    setup({ error: "This invite has expired — ask the team owner for a new link." });
    expect(screen.getByText(/This invite has expired/)).toBeTruthy();
  });

  it("is announced as a modal dialog", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toContain("Helios Platform");
  });
});
