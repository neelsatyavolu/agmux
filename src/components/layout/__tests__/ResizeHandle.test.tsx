/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ResizeHandle } from "../ResizeHandle";

afterEach(() => cleanup());

describe("ResizeHandle", () => {
  it("renders without crashing with default props", () => {
    const { container } = render(<ResizeHandle onResize={() => {}} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("applies horizontal class by default", () => {
    const { container } = render(<ResizeHandle onResize={() => {}} />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("cursor-col-resize");
  });

  it("applies vertical class when direction='vertical'", () => {
    const { container } = render(
      <ResizeHandle direction="vertical" onResize={() => {}} />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("cursor-row-resize");
  });

  it("merges custom className", () => {
    const { container } = render(
      <ResizeHandle onResize={() => {}} className="my-extra-class" />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("my-extra-class");
  });

  it("calls onResize with horizontal delta on drag", () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const root = container.firstChild as HTMLElement;

    fireEvent.mouseDown(root, { clientX: 100, clientY: 50 });
    fireEvent.mouseMove(document, { clientX: 110, clientY: 50 });
    expect(onResize).toHaveBeenCalledWith(10);

    fireEvent.mouseUp(document);
  });

  it("calls onResize with vertical delta when direction='vertical'", () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizeHandle direction="vertical" onResize={onResize} />,
    );
    const root = container.firstChild as HTMLElement;

    fireEvent.mouseDown(root, { clientX: 50, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 50, clientY: 95 });
    expect(onResize).toHaveBeenCalledWith(-5);

    fireEvent.mouseUp(document);
  });

  it("does not invoke onResize when delta is zero", () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const root = container.firstChild as HTMLElement;

    fireEvent.mouseDown(root, { clientX: 100, clientY: 50 });
    fireEvent.mouseMove(document, { clientX: 100, clientY: 50 });
    expect(onResize).not.toHaveBeenCalled();

    fireEvent.mouseUp(document);
  });

  it("stops listening after mouseUp", () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const root = container.firstChild as HTMLElement;

    fireEvent.mouseDown(root, { clientX: 100, clientY: 50 });
    fireEvent.mouseUp(document);
    onResize.mockClear();

    fireEvent.mouseMove(document, { clientX: 200, clientY: 50 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
