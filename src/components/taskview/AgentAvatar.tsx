import claudeIcon from "../../assets/claudewhiteicon.svg";
import codexIcon from "../../assets/chatgpt-icon.svg";
import droidIcon from "../../assets/droid-icon.svg";
import kimiIcon from "../../assets/kimi-icon.svg";
import piIcon from "../../assets/pi-icon.svg";
import opencodeIcon from "../../assets/opencode-icon.png";
import appleIcon from "../../assets/apple-icon.svg";
import grokIcon from "../../assets/grok-icon.svg";
import cursorIcon from "../../assets/cursor-app-icon.png";
import clineIcon from "../../assets/cline-icon.svg";
import geminiIcon from "../../assets/gemini-icon.svg";
import hermesIcon from "../../assets/hermes-icon.png";
import type { Provider } from "../../lib/types";

interface AgentAvatarProps {
  provider: Provider;
  size?: number;
}

interface AvatarMeta {
  bg: string;
  src?: string;
  label: string;
  // Icons that contain their own background (full app-icon SVGs) should fill
  // the chip edge-to-edge instead of floating at 63% inside a frame.
  fullBleed?: boolean;
}

const META: Record<Provider, AvatarMeta> = {
  ClaudeCode: { bg: "#C15F3C", src: claudeIcon, label: "C" },
  Codex: { bg: "#ffffff", src: codexIcon, label: "X", fullBleed: true },
  Droid: { bg: "#020202", src: droidIcon, label: "D", fullBleed: true },
  Kimi: { bg: "#020202", src: kimiIcon, label: "K", fullBleed: true },
  Pi: { bg: "#111111", src: piIcon, label: "π", fullBleed: true },
  OpenCode: { bg: "#334155", src: opencodeIcon, label: "O", fullBleed: true },
  MLX: { bg: "#ffffff", src: appleIcon, label: "A", fullBleed: true },
  Grok: { bg: "#0a0a0a", src: grokIcon, label: "G", fullBleed: true },
  Cursor: { bg: "#ffffff", src: cursorIcon, label: "C", fullBleed: true },
  Cline: { bg: "#111111", src: clineIcon, label: "L", fullBleed: true },
  Gemini: { bg: "#0b1220", src: geminiIcon, label: "G", fullBleed: true },
  Hermes: { bg: "#1A1714", src: hermesIcon, label: "H", fullBleed: true },
};

export function AgentAvatar({ provider, size = 22 }: AgentAvatarProps) {
  const meta = META[provider] ?? META.OpenCode;
  const icon = meta.fullBleed ? size : Math.round(size * 0.63);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: meta.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {meta.src ? (
        <img src={meta.src} alt="" style={{ width: icon, height: icon, display: "block" }} />
      ) : (
        <span
          style={{
            fontSize: Math.round(size * 0.45),
            fontWeight: 700,
            color: "#fff",
            fontFamily: "var(--font-sans)",
          }}
        >
          {meta.label}
        </span>
      )}
    </div>
  );
}
