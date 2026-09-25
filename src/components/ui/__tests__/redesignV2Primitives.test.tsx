import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionEyebrow } from "../panel/SectionEyebrow";
import { DropdownHeader, DropdownRow, DropdownKbd, DropdownTag } from "../ComposerDropdown";
import { GlassButton } from "../GlassButton";
import { SegmentedControl } from "../SegmentedControl";
import { SettingsCard, PageHeader } from "../../settings/settingsLayout";
import { ChoiceGroup } from "../../settings/accounts/ChoiceGroup";
import { STOP_BTN, SEND_BTN_IDLE } from "../../thread/composerChrome";
import { primaryButton } from "../../settings/accounts/styles";

afterEach(() => cleanup());

describe("redesign v2 primitives", () => {
  it("eyebrows are sans ui-eyebrow, never mono", () => {
    render(<SectionEyebrow label="Usage" />);
    const el = screen.getByText("Usage");
    expect(el.className).toContain("ui-eyebrow");
    expect(el.className).not.toContain("font-mono");
  });
  it("dropdown header/kbd/tag/row use the vocabulary", () => {
    render(<><DropdownHeader title="Model" kbd="⌘M" /><DropdownKbd>⌘1</DropdownKbd><DropdownTag>New</DropdownTag>
      <DropdownRow title="Opus" meta="Conversational agent" selected /></>);
    expect(screen.getByText("Model").className).toContain("ui-eyebrow");
    expect(screen.getByText("⌘M").className).toContain("ui-kbd");
    expect(screen.getByText("⌘1").className).toContain("ui-kbd");
    expect(screen.getByText("New").className).toContain("ui-chip");
    expect(screen.getByText("Conversational agent").className).not.toContain("font-mono");
    expect(screen.getByRole("button").getAttribute("data-selected")).toBe("true");
  });
  it("GlassButton exposes variant/size and a 40px lg size", () => {
    render(<GlassButton variant="accent" size="lg">Approve</GlassButton>);
    const b = screen.getByRole("button");
    expect(b.className).toContain("ui-btn");
    expect(b.getAttribute("data-variant")).toBe("accent");
    expect(b.getAttribute("data-size")).toBe("lg");
  });
  it("segments mark the active item", () => {
    render(<SegmentedControl segments={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} value="b" onChange={() => {}} />);
    expect(screen.getByText("B").closest("button")!.getAttribute("data-active")).toBe("true");
    expect(screen.getByText("B").closest("button")!.className).toContain("ui-seg-item");
  });
  it("choice groups mark the active item", () => {
    render(<ChoiceGroup label="Scope" choices={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} value="a" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "A" }).getAttribute("data-active")).toBe("true");
  });
  it("settings eyebrow + title use the vocabulary", () => {
    render(<><PageHeader title="Appearance" /><SettingsCard eyebrow="Account" title="Git">x</SettingsCard></>);
    expect(screen.getByText("Appearance").className).toContain("ui-title-xl");
    const eb = screen.getByText("Account");
    expect(eb.className).toContain("ui-eyebrow");
    expect(eb.getAttribute("style") ?? "").not.toContain("font-mono");
  });
  it("composer + account buttons get flat markers", () => {
    expect(STOP_BTN).toContain("composer-stop");
    expect(SEND_BTN_IDLE).toContain("fx-panel-2");
    expect(primaryButton).toContain("fx-accent");
  });
});
