/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EffortSelector } from "../EffortSelector";
afterEach(cleanup);
const options = [{ value: "low", label: "Low" }, { value: "high", label: "High" }];
it("retains the blocked effort label and only offers allowed efforts", () => {
  const onChange = vi.fn();
  render(<EffortSelector options={options} value="high" allowedValues={["low"]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort: High" }));
  expect(screen.getByText(/This choice is blocked/)).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("slider"), { key: "Home" });
  expect(onChange).toHaveBeenCalledWith("low");
});
it("shows why an empty allowlist has no selectable effort", () => {
  render(<EffortSelector options={options} value="high" allowedValues={[]} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Reasoning effort: High" }));
  expect(screen.getByText(/No choices are allowed/)).toBeTruthy();
  expect(screen.queryByRole("slider")).toBeNull();
});
