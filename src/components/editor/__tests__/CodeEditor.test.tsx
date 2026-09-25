/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";

vi.mock("../../../lib/commands", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../ThemeProvider", () => ({
  useResolvedColorMode: () => false,
}));
vi.mock("../../thread/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { CodeEditor } from "../CodeEditor";
import { readFile } from "../../../lib/commands";
import { useEditorStore } from "../../../stores/editorStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useEditorStore.setState({ fileContents: {}, dirtyFiles: {}, rawMode: {} });
});

describe("CodeEditor", () => {
  it("recovers from a file that failed to load when another file is opened", async () => {
    vi.mocked(readFile).mockImplementation(async (path: string) => {
      if (path.endsWith(".png")) throw new Error("stream did not contain valid UTF-8");
      return "export const ok = 1;\n";
    });
    const { rerender } = render(<CodeEditor filePath="/r/logo.png" />);
    await screen.findByText("Failed to load file");

    rerender(<CodeEditor filePath="/r/a.ts" />);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/r/a.ts"));
    await waitFor(() => expect(screen.queryByText("Failed to load file")).toBeNull());
  });
});
