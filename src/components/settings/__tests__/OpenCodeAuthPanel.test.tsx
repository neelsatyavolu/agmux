/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { OpenCodeAuthPanel } from "../OpenCodeAuthPanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/opencodeSdkCommands", () => ({
  opencodeSdk: {
    listAuthMethods: vi.fn().mockResolvedValue([]),
    setApiKey: vi.fn().mockResolvedValue(undefined),
    removeAuth: vi.fn().mockResolvedValue(undefined),
    oauthAuthorize: vi.fn().mockResolvedValue({ url: "" }),
    oauthCallback: vi.fn().mockResolvedValue(undefined),
  },
}));

afterEach(() => cleanup());

describe("OpenCodeAuthPanel", () => {
  it("renders bridgeReady=false hint", () => {
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady={false} />);
    expect(screen.getByText(/set the opencode binary path/i)).toBeTruthy();
  });

  it("renders Providers section when bridgeReady (after load)", async () => {
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/^providers$/i)).toBeTruthy();
    });
  });

  it("renders 'No providers' message when list is empty", async () => {
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(
        screen.getByText(/no providers reported by opencode/i),
      ).toBeTruthy();
    });
  });

  it("renders Refresh button when bridgeReady (after load)", async () => {
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/refresh/i)).toBeTruthy();
    });
  });

  it("calls listAuthMethods when bridgeReady becomes true", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockClear();
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(opencodeSdk.listAuthMethods).toHaveBeenCalled();
    });
  });

  it("renders provider rows when listAuthMethods returns data", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "anthropic",
        name: "Anthropic",
        isConnected: true,
        methods: [],
      },
      {
        providerID: "openai",
        name: "OpenAI",
        isConnected: false,
        methods: [],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(
        screen.queryByText(/no providers reported by opencode/i),
      ).toBeNull();
    });
  });

  it("does not render Providers section when bridgeReady=false", () => {
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady={false} />);
    expect(screen.queryByText(/^providers$/i)).toBeNull();
  });
});

import { fireEvent } from "@testing-library/react";

describe("OpenCodeAuthPanel — Final coverage gaps", () => {
  it("renders Connected pill for connected providers", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "anthropic",
        name: "Anthropic",
        isConnected: true,
        methods: [],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText("Anthropic")).toBeTruthy();
      expect(screen.getByText(/connected/i)).toBeTruthy();
    });
  });

  it("renders Disconnected pill for disconnected providers", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "openai",
        name: "OpenAI",
        isConnected: false,
        methods: [],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getAllByText(/disconnected/i).length).toBeGreaterThan(0);
    });
  });

  it("renders apiKey method as 'Use API key' button", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "x",
        name: "X",
        isConnected: false,
        methods: [{ type: "apiKey" }],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/use api key/i)).toBeTruthy();
    });
  });

  it("clicking 'Use API key' shows password input", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "x",
        name: "X",
        isConnected: false,
        methods: [{ type: "apiKey" }],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/use api key/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/use api key/i));
    expect(screen.getByPlaceholderText("Paste API key")).toBeTruthy();
  });

  it("submitting an API key calls setApiKey", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValue([
      {
        providerID: "x",
        name: "X",
        isConnected: false,
        methods: [{ type: "apiKey" }],
      },
    ] as never);
    vi.mocked(opencodeSdk.setApiKey).mockResolvedValueOnce({
      connected: true,
      envVars: [],
    } as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/use api key/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/use api key/i));
    const input = screen.getByPlaceholderText("Paste API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByText("Save"));
    await new Promise((r) => setTimeout(r, 0));
    expect(opencodeSdk.setApiKey).toHaveBeenCalledWith("x", "sk-test-123");
  });

  it("renders OAuth method as 'Sign in with OAuth' button", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "y",
        name: "Y",
        isConnected: false,
        methods: [{ type: "oauth" }],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/sign in with oauth/i)).toBeTruthy();
    });
  });

  it("clicking OAuth start invokes oauthAuthorize", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValue([
      {
        providerID: "y",
        name: "Y",
        isConnected: false,
        methods: [{ type: "oauth" }],
      },
    ] as never);
    vi.mocked(opencodeSdk.oauthAuthorize).mockResolvedValueOnce({
      url: "https://provider.com/oauth",
    } as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/sign in with oauth/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/sign in with oauth/i));
    await new Promise((r) => setTimeout(r, 0));
    expect(opencodeSdk.oauthAuthorize).toHaveBeenCalled();
  });

  it("Sign out is rendered for connected providers", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "z",
        name: "Z",
        isConnected: true,
        methods: [],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/sign out/i)).toBeTruthy();
    });
  });

  it("clicking Sign out invokes removeAuth", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValue([
      {
        providerID: "z",
        name: "Z",
        isConnected: true,
        methods: [],
      },
    ] as never);
    vi.mocked(opencodeSdk.removeAuth).mockClear();
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/sign out/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/sign out/i));
    await new Promise((r) => setTimeout(r, 0));
    expect(opencodeSdk.removeAuth).toHaveBeenCalledWith("z");
  });

  it("search input filters providers", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      { providerID: "alpha", name: "Alpha", isConnected: false, methods: [] },
      { providerID: "beta", name: "Beta", isConnected: false, methods: [] },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeTruthy();
    });
    const search = screen.getByPlaceholderText(/search providers/i) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "alph" } });
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("search shows 'No providers match' when filter excludes all", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      { providerID: "alpha", name: "Alpha", isConnected: false, methods: [] },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeTruthy();
    });
    const search = screen.getByPlaceholderText(/search providers/i) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzznotfound" } });
    expect(screen.getByText(/no providers match/i)).toBeTruthy();
  });

  it("search clear button resets to full list", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      { providerID: "alpha", name: "Alpha", isConnected: false, methods: [] },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeTruthy();
    });
    const search = screen.getByPlaceholderText(/search providers/i) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "alph" } });
    fireEvent.click(screen.getByTitle("Clear search"));
    expect(search.value).toBe("");
  });

  it("error from listAuthMethods is rendered", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockRejectedValueOnce(
      new Error("connection refused"),
    );
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/connection refused/i)).toBeTruthy();
    });
  });

  it("renders unsupported method type as a hint", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "weird",
        name: "Weird",
        isConnected: false,
        methods: [{ type: "magic_token" } as never],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/not yet supported/i)).toBeTruthy();
    });
  });

  it("Refresh button triggers another listAuthMethods call", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValue([] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/refresh/i)).toBeTruthy();
    });
    vi.mocked(opencodeSdk.listAuthMethods).mockClear();
    fireEvent.click(screen.getByText(/refresh/i));
    await new Promise((r) => setTimeout(r, 0));
    expect(opencodeSdk.listAuthMethods).toHaveBeenCalled();
  });

  it("renders 'No auth methods' when methods array is empty for disconnected", async () => {
    const { opencodeSdk } = await import("../../../lib/opencodeSdkCommands");
    vi.mocked(opencodeSdk.listAuthMethods).mockResolvedValueOnce([
      {
        providerID: "p",
        name: "P",
        isConnected: false,
        methods: [],
      },
    ] as never);
    render(<OpenCodeAuthPanel directory="/tmp/p" bridgeReady />);
    await waitFor(() => {
      expect(screen.getByText(/no auth methods/i)).toBeTruthy();
    });
  });
});
