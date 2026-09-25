/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  ProviderModelDropdown,
  recentsWithCurrent,
  sortProvidersByRecency,
} from "../ProviderModelDropdown";
import { useSettingsStore } from "../../../stores/settingsStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderModelDropdown", () => {
  it("renders with default Claude provider label when no model selected", () => {
    render(
      <ProviderModelDropdown provider="ClaudeCode" model={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("renders Codex provider label", () => {
    render(<ProviderModelDropdown provider="Codex" model={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("renders OpenCode provider label", () => {
    render(
      <ProviderModelDropdown provider="OpenCode" model={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("OpenCode")).toBeTruthy();
  });

  it("renders Kimi provider label", () => {
    render(
      <ProviderModelDropdown provider="Kimi" model={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Kimi")).toBeTruthy();
  });

  it("locks a Gemini session picker to Gemini models", () => {
    render(
      <ProviderModelDropdown
        provider="Gemini"
        model="gemini-3.8-flash-high"
        allowedProviders={["Gemini"]}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("Gemini 3.8 Flash").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Gemini 3.1 Pro")).toBeTruthy();
    expect(screen.queryByText("Claude Fable 5.1")).toBeNull();
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    expect(screen.queryByText(/GPT 5\.6 Sol/)).toBeNull();
    expect(screen.queryByText(/Composer/)).toBeNull();
  });

  it("renders a clean Gemini model name without the raw slug", () => {
    render(
      <ProviderModelDropdown
        provider="Gemini"
        model="gemini-3.8-flash-high"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Gemini 3.8 Flash")).toBeTruthy();
    expect(screen.queryByText(/gemini-3\.8-flash/i)).toBeNull();
  });

  it("renders Claude model label when a known Claude slug is selected", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model="sonnet"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Claude Sonnet 4.6")).toBeTruthy();
  });

  it("opens dropdown popover when button is clicked", () => {
    render(
      <ProviderModelDropdown provider="ClaudeCode" model={null} onSelect={vi.fn()} />,
    );
    const button = screen.getByRole("button");
    fireEvent.click(button);
    // After opening, the popover should mount additional content somewhere in the dom
    // We just confirm the button is still present and didn't crash
    expect(button).toBeTruthy();
  });

  it("renders compact mode without label text", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        compact
      />,
    );
    // Compact mode hides text, keeps icon — the button still has aria-label
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-label")).toBe("Claude");
  });

  it("does not crash with claudeOnly prop", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        claudeOnly
      />,
    );
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("does not crash with opencodeOnly prop", () => {
    render(
      <ProviderModelDropdown
        provider="OpenCode"
        model={null}
        onSelect={vi.fn()}
        opencodeOnly
      />,
    );
    expect(screen.getByText("OpenCode")).toBeTruthy();
  });

  it("shows selected running session title on the trigger", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model="sonnet"
        onSelect={vi.fn()}
        runningSessions={[
          {
            id: "sess-1",
            title: "Fix auth bug",
            projectName: "agmux",
            provider: "ClaudeCode",
            state: "running",
          },
        ]}
        selectedSessionId="sess-1"
        onSelectSession={vi.fn()}
      />,
    );
    expect(screen.getByText("Fix auth bug")).toBeTruthy();
  });

  it("lists running sessions in flat layout when opened", () => {
    const onSelectSession = vi.fn();
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        runningSessions={[
          {
            id: "sess-1",
            title: "Live agent",
            projectName: "demo",
            provider: "Codex",
            state: "waiting",
          },
        ]}
        selectedSessionId={null}
        onSelectSession={onSelectSession}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Running sessions")).toBeTruthy();
    fireEvent.click(screen.getByText("Live agent"));
    expect(onSelectSession).toHaveBeenCalledWith("sess-1");
  });

  it("L3: a waiting session's 'Wait' tag is amber (needs-you), not violet (thinking) — matches Home's gold approve chip for the same state", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
        runningSessions={[
          {
            id: "sess-1",
            title: "Live agent",
            projectName: "demo",
            provider: "Codex",
            state: "waiting",
          },
        ]}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.mouseEnter(screen.getByText("Running sessions").closest("div")!);
    const tag = screen.getByText("Wait");
    expect(tag.className).toContain("fx-soft-gold");
    expect(tag.className).not.toContain("violet");
  });
});

describe("ProviderModelDropdown — Final coverage gaps", () => {
  it("renders prettified Codex model name when slug is unknown", () => {
    render(
      <ProviderModelDropdown
        provider="Codex"
        model="gpt-5.5-mini"
        onSelect={vi.fn()}
      />,
    );
    // prettifyCodexModelName fallback runs
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("renders OpenCode model with prettified slug", () => {
    render(
      <ProviderModelDropdown
        provider="OpenCode"
        model="custom-provider/some-model"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("renders custom Codex models override (codexModels prop)", () => {
    render(
      <ProviderModelDropdown
        provider="Codex"
        model="custom-x"
        onSelect={vi.fn()}
        codexModels={[
          { slug: "custom-x", name: "Custom X" },
        ] as never}
      />,
    );
    expect(screen.getByText("Custom X")).toBeTruthy();
  });

  it("opening claudeOnly dropdown shows Claude submenu models", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model="sonnet"
        onSelect={vi.fn()}
        claudeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText(/Claude Sonnet 4\.6/).length).toBeGreaterThan(0);
  });

  it("opening collapsibleSections dropdown shows provider rows", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/OpenAI/).length).toBeGreaterThan(0);
  });

  it("selects Cursor Composer 2.5 from the collapsible provider picker", () => {
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={onSelect}
        collapsibleSections
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    fireEvent.mouseEnter(screen.getByText("Cursor").closest("div")!);
    fireEvent.click(screen.getByText("Cursor Composer 2.5"));

    expect(onSelect).toHaveBeenCalledWith("Cursor", "composer-2.5");
  });

  it("still labels historical Grok Composer threads but does not list Composer in the xAI picker", () => {
    render(
      <ProviderModelDropdown
        provider="Grok"
        model="composer-2.5"
        onSelect={vi.fn()}
        collapsibleSections
      />,
    );

    // Trigger keeps a friendly name for old threads that used Composer under Grok.
    expect(screen.getByText("Composer 2.5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button"));
    const grokRows = screen.getAllByText("xAI · Grok");
    fireEvent.mouseEnter(grokRows[0]!.closest("div")!);
    // Composer is Cursor-only now — not offered under xAI chat.
    expect(screen.queryByText("coding agent")).toBeNull();
    expect(screen.getByText("Grok 4.7")).toBeTruthy();
    expect(screen.getByText("Grok 4.6")).toBeTruthy();
    expect(screen.getByText("Grok 4.5")).toBeTruthy();
  });

  it("uses dynamic Cursor models in the provider picker", () => {
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="Cursor"
        model="cursor-pro"
        onSelect={onSelect}
        cursorModels={[
          {
            slug: "cursor-pro?thinking=high",
            name: "Cursor Pro",
            description: "dynamic",
          },
        ]}
        collapsibleSections
      />,
    );

    expect(screen.getByText("Cursor Pro")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    const row = screen.getAllByRole("button").find((button) =>
      button.textContent?.includes("Cursor Pro") && button.textContent?.includes("dynamic")
    );
    expect(row).toBeTruthy();
    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("Cursor", "cursor-pro?thinking=high");
  });

  it("marks a Cursor base model selected when the stored slug includes parameters", () => {
    render(
      <ProviderModelDropdown
        provider="Cursor"
        model="composer-2.5?thinking=high"
        onSelect={vi.fn()}
        cursorModels={[
          {
            slug: "composer-2.5",
            name: "Cursor Composer 2.5",
            description: "dynamic",
          },
        ]}
        collapsibleSections
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const row = screen.getAllByRole("button").find((button) =>
      button.textContent?.includes("Cursor Composer 2.5") && button.textContent?.includes("dynamic")
    );
    expect(row).toBeTruthy();
    // Live/dynamic tag uses brand accent chrome (was emerald).
    expect(row!.innerHTML).toContain("var(--accent");
  });

  it("opening opencodeOnly dropdown lists OpenCode models", () => {
    render(
      <ProviderModelDropdown
        provider="OpenCode"
        model="anthropic/claude-sonnet-4-5"
        onSelect={vi.fn()}
        opencodeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText(/OpenCode/).length).toBeGreaterThan(0);
  });

  it("clicking a Claude model in flat dropdown calls onSelect", () => {
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={onSelect}
        claudeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Claude Sonnet 4.6"));
    expect(onSelect).toHaveBeenCalledWith("ClaudeCode", "sonnet");
  });

  it("renders custom Claude models override (claudeModels prop)", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        claudeOnly
        claudeModels={[{ slug: "claude-fable-6", name: "Claude Fable 6" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Claude Fable 6")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });

  it("lists Claude Fable 5 in the flat Claude dropdown", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        claudeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Claude Fable 5")).toBeTruthy();
  });

  it("lists and selects Claude Opus 5 from the flat Claude dropdown", () => {
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={onSelect}
        claudeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Claude Opus 5")).toBeTruthy();
    fireEvent.click(screen.getByText("Claude Opus 5"));
    expect(onSelect).toHaveBeenCalledWith("ClaudeCode", "claude-opus-5[1m]");
  });

  it("selects Claude Sonnet 5 from the flat Claude dropdown", () => {
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={onSelect}
        claudeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Claude Sonnet 5"));
    expect(onSelect).toHaveBeenCalledWith("ClaudeCode", "claude-sonnet-5");
  });

  it("clicking an OpenCode model in opencodeOnly mode calls onSelect", () => {
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="OpenCode"
        model={null}
        onSelect={onSelect}
        opencodeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const sonnet = screen.getByText("Claude Sonnet 4.5");
    fireEvent.click(sonnet);
    expect(onSelect).toHaveBeenCalledWith("OpenCode", "anthropic/claude-sonnet-4-5");
  });

  it("renders dynamic OpenCode models when opencodeModels prop is provided", () => {
    render(
      <ProviderModelDropdown
        provider="OpenCode"
        model={null}
        onSelect={vi.fn()}
        opencodeOnly
        opencodeModels={[
          { slug: "x/abc", name: "ABC", connected: true },
          { slug: "x/def", name: "DEF", connected: false },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // Default list shows connected models only (disconnected need search).
    expect(screen.getByText("ABC")).toBeTruthy();
    expect(screen.queryByText("DEF")).toBeNull();
    // Searching unlocks the full catalog including un-authed models.
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
      target: { value: "DEF" },
    });
    expect(screen.getByText("DEF")).toBeTruthy();
  });

  it("clicks outside the dropdown close it", async () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        claudeOnly
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByText(/Claude Sonnet 4\.6/).length).toBeGreaterThan(0);
    // mousedown outside
    fireEvent.mouseDown(document.body);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("renders compact button without chevron text", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        compact
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn.textContent ?? "").not.toContain("Claude");
  });

  it("displays the selected Codex model name from CODEX_MODELS", () => {
    render(
      <ProviderModelDropdown
        provider="Codex"
        model="gpt-5.4"
        onSelect={vi.fn()}
      />,
    );
    // Some Codex slug should map to a friendly name; just verify button text exists
    expect(screen.getByRole("button").textContent?.length).toBeGreaterThan(0);
  });

  it("handles unknown Kimi model gracefully (no crash)", () => {
    render(
      <ProviderModelDropdown
        provider="Kimi"
        model="droid-1"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("clicking compact mode button still toggles dropdown", () => {
    const { container } = render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        compact
      />,
    );
    const triggerBtn = container.querySelector("button[aria-label='Claude']") as HTMLButtonElement;
    fireEvent.click(triggerBtn);
    // After click, additional buttons appear in dropdown
    expect(container.querySelectorAll("button").length).toBeGreaterThan(1);
  });

  it("renders with opencodeRecents prop and bubbles recent models to top", () => {
    render(
      <ProviderModelDropdown
        provider="OpenCode"
        model={null}
        onSelect={vi.fn()}
        opencodeOnly
        opencodeRecents={["openai/gpt-5.4"]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // Labels use spaced display names (e.g. "GPT 5.4"), not hyphenated slugs.
    expect(screen.getByText("GPT 5.4")).toBeTruthy();
  });

  it("mlxOnly dropdown only shows MLX models", async () => {
    vi.mocked(invoke).mockResolvedValue({
      supported: true,
      available: true,
      reason: null,
      needsPython: false,
      needsVenv: false,
      needsModel: false,
    } as never);

    render(
      <ProviderModelDropdown
        provider="MLX"
        model="mlx-community/qwen-test"
        onSelect={vi.fn()}
        mlxOnly
        allowedProviders={["MLX"]}
        allowedModels={["local/mlx-community/qwen-test"]}
        mlxModels={[
          {
            id: "mlx-community/qwen-test",
            displayName: "Qwen Test",
            path: "/tmp/qwen-test",
            source: "huggingFace",
            sizeBytes: 123456789,
            quant: "4bit",
            contextWindow: 32768,
            supportsTools: true,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("Local Model")).toBeTruthy();
    expect(screen.getByText("Qwen Test").closest("button")?.disabled).toBe(false);
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(screen.queryByText(/OpenAI/)).toBeNull();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });

  it("shows the Local Model tile when zero models are installed (discoverability)", async () => {
    // Real shape returned by the Rust side when model_count == 0
    // (src-tauri/src/mlx/capability.rs) — available is false, but the machine
    // is `supported`, which is what keeps the tile visible.
    vi.mocked(invoke).mockResolvedValue({
      supported: true,
      available: false,
      reason: "No local models installed yet.",
      needsPython: false,
      needsVenv: false,
      needsModel: true,
    } as never);

    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
        mlxModels={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("Local Model")).toBeTruthy();
  });

  it("shows the Local Model tile when models exist but the runtime is missing", async () => {
    // The shakedown state: models on disk, no `~/.agmux/mlx/venv`. The old
    // gate (`available || needsModel`) was false here and the tile vanished.
    vi.mocked(invoke).mockResolvedValue({
      supported: true,
      available: false,
      reason: "Local model runtime is not installed yet.",
      needsPython: false,
      needsVenv: true,
      needsModel: false,
    } as never);

    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
        mlxModels={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("Local Model")).toBeTruthy();
  });

  it("hides the Local Model tile on a machine that cannot run MLX", async () => {
    vi.mocked(invoke).mockResolvedValue({
      supported: false,
      available: false,
      reason: "Local models need an Apple Silicon Mac.",
      needsPython: false,
      needsVenv: false,
      needsModel: false,
    } as never);

    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
        mlxModels={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    await Promise.resolve();

    expect(screen.queryByText("Local Model")).toBeNull();
  });

  it("collapsible picker opened on MLX shows MLX models (not Anthropic)", async () => {
    vi.mocked(invoke).mockResolvedValue({
      supported: true,
      available: true,
      reason: null,
      needsPython: false,
      needsVenv: false,
      needsModel: false,
    } as never);

    render(
      <ProviderModelDropdown
        provider="MLX"
        model="lmstudio-community/qwen-test"
        onSelect={vi.fn()}
        collapsibleSections
        mlxModels={[
          {
            id: "lmstudio-community/qwen-test",
            displayName: "Qwen Test 4bit",
            path: "/tmp/qwen-test",
            source: "lmStudio",
            sizeBytes: 123456789,
            quant: "4bit",
            contextWindow: 32768,
            supportsTools: true,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    // Flyout opens on the selected MLX provider (not Anthropic) and lists
    // the local model under its LM Studio source group.
    expect(await screen.findByText("Qwen Test 4bit")).toBeTruthy();
    expect(screen.getByText("LM Studio")).toBeTruthy();
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
  });

  it("OpenCode provider row counts only connected models when mixed", async () => {
    vi.mocked(invoke).mockResolvedValue({
      supported: true,
      available: true,
      reason: null,
      needsPython: false,
      needsVenv: false,
      needsModel: false,
    } as never);

    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
        opencodeModels={[
          { slug: "anthropic/claude-sonnet-4-5", name: "Sonnet", connected: true },
          { slug: "openai/gpt-5", name: "GPT-5", connected: true },
          { slug: "openrouter/foo", name: "Foo", connected: false },
          { slug: "openrouter/bar", name: "Bar", connected: false },
          { slug: "openrouter/baz", name: "Baz", connected: false },
          { slug: "openrouter/qux", name: "Qux", connected: false },
          { slug: "openrouter/quux", name: "Quux", connected: false },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    // Subtitle should prefer connected count (2), not the full catalog (7).
    // Scope to the OpenCode row — Grok also uses a "3 models" subtitle.
    const opencodeRow = screen.getByText("OpenCode").closest("div");
    expect(opencodeRow?.textContent).toContain("2 models");
    expect(opencodeRow?.textContent).not.toContain("7 models");
  });
});

describe("sortProvidersByRecency", () => {
  const all = [
    "ClaudeCode",
    "Codex",
    "OpenCode",
    "Gemini",
    "Grok",
    "Cursor",
    "MLX",
  ] as const;

  it("keeps the canonical cascade order when nothing has been used", () => {
    expect(sortProvidersByRecency(all, [])).toEqual([...all]);
  });

  it("lists recent providers first, then the unused canonical rest", () => {
    expect(sortProvidersByRecency(all, ["Gemini", "Cursor"])).toEqual([
      "Gemini",
      "Cursor",
      "ClaudeCode",
      "Codex",
      "OpenCode",
      "Grok",
      "MLX",
    ]);
  });
});

describe("recentsWithCurrent", () => {
  it("puts the current provider first and dedupes", () => {
    expect(recentsWithCurrent("Gemini", ["Codex", "Gemini", "Cursor"])).toEqual([
      "Gemini",
      "Codex",
      "Cursor",
    ]);
  });
});

describe("ProviderModelDropdown — cascade recency", () => {
  afterEach(() => {
    useSettingsStore.getState().resetSettings();
  });

  function cascadeListText() {
    const header = screen.getByText("Model");
    return header.closest("div")?.parentElement?.textContent ?? "";
  }

  it("lists the current provider first in the cascade picker", () => {
    render(
      <ProviderModelDropdown
        provider="Gemini"
        model="gemini-3.8-flash"
        onSelect={vi.fn()}
        collapsibleSections
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const text = cascadeListText();
    expect(text.indexOf("Gemini")).toBeLessThan(text.indexOf("Anthropic"));
  });

  it("orders the cascade by recent usage after the current provider", () => {
    render(
      <ProviderModelDropdown
        provider="Gemini"
        model="gemini-3.8-flash"
        onSelect={vi.fn()}
        collapsibleSections
        recentProviders={["Gemini", "Cursor", "OpenCode"]}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const text = cascadeListText();
    expect(text.indexOf("Gemini")).toBeLessThan(text.indexOf("Cursor"));
    expect(text.indexOf("Cursor")).toBeLessThan(text.indexOf("OpenCode"));
    expect(text.indexOf("OpenCode")).toBeLessThan(text.indexOf("Anthropic"));
  });

  it("caps the cascade list so about four providers show at a time", () => {
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={vi.fn()}
        collapsibleSections
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    const header = screen.getByText("Model");
    const list = header.closest("div")?.nextElementSibling as HTMLElement | null;
    expect(list?.style.maxHeight).toBe("200px");
    expect(list?.style.overflowY).toBe("auto");
  });

  it("records a selected provider as most recent", () => {
    useSettingsStore.getState().resetSettings();
    const onSelect = vi.fn();
    render(
      <ProviderModelDropdown
        provider="ClaudeCode"
        model={null}
        onSelect={onSelect}
        collapsibleSections
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.mouseEnter(screen.getByText("Gemini").closest("div")!);
    fireEvent.click(screen.getByText("Gemini 3.8 Flash"));
    expect(onSelect).toHaveBeenCalledWith("Gemini", "gemini-3.8-flash");
    expect(useSettingsStore.getState().settings.recentProviders[0]).toBe("Gemini");
  });
});

describe("picker team restrictions", () => {
  it("shows an empty explanation and no model choices for an empty provider list", () => {
    const onSelect = vi.fn();
    render(<ProviderModelDropdown provider="ClaudeCode" model="sonnet" allowedProviders={[]} onSelect={onSelect} claudeOnly />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("No agents are available under the current restrictions.")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("keeps the model and disables denied choices in a locked provider picker", () => {
    const onSelect = vi.fn();
    render(<ProviderModelDropdown provider="Gemini" model="gemini-3.8-flash-high" allowedProviders={["Gemini"]} allowedModels={[]} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    const blocked = screen.getAllByTitle("Model blocked by team restrictions");
    expect(blocked.length).toBeGreaterThan(0);
    for (const row of blocked) {
      expect((row as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(row);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});

it("checks a composer’s dispatched Gemini slug without changing the picker selection", () => {
  const onSelect = vi.fn();
  render(<ProviderModelDropdown provider="Gemini" model="gemini-3.8-flash-high" allowedProviders={["Gemini"]} allowedModels={["gemini-3.8-flash-high"]} resolvePolicyModel={(_p, m) => `${m}-high`} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button"));
  const row = screen.getAllByText("Gemini 3.8 Flash").map(el => el.closest("button")).find(el => el?.textContent?.includes("default"))!;
  expect(row.disabled).toBe(false);
  fireEvent.click(row);
  expect(onSelect).toHaveBeenCalledWith("Gemini", "gemini-3.8-flash");
});
it.each([
  { allowed: ["MLX"] as const, localDisabled: false, cloudDisabled: true },
  { allowed: ["OpenCode"] as const, localDisabled: true, cloudDisabled: false },
])("classifies local model rows independently of the OpenCode transport: $allowed", ({ allowed, localDisabled, cloudDisabled }) => {
  const onSelect = vi.fn();
  render(<ProviderModelDropdown provider="OpenCode" model="local/org/model" allowedProviders={allowed} allowedModels={["local/org/model", "anthropic/cloud"]} opencodeOnly opencodeModels={[
    { slug: "local/org/model", name: "Local Test Model" },
    { slug: "anthropic/cloud", name: "Cloud Test Model" },
  ]} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button"));
  const local = screen.getByText("Local Test Model").closest("button")!;
  const cloud = screen.getByText("Cloud Test Model").closest("button")!;
  expect(local.disabled).toBe(localDisabled);
  expect(cloud.disabled).toBe(cloudDisabled);
  fireEvent.click(localDisabled ? cloud : local);
  expect(onSelect).toHaveBeenCalledWith("OpenCode", localDisabled ? "anthropic/cloud" : "local/org/model");
});
