/**
 * 12-ray warm starburst — variant A1 from the "claude-thinking-ambient" design exploration.
 * Each ray pulses on a staggered ca-ray opacity cycle, producing a slow rotational shimmer
 * without actually rotating. Distinctive shape, no generic spinner feel.
 */

interface ClaudeStarburstSpinnerProps {
  size?: number;
  color?: string;
  duration?: string;
  className?: string;
}

const RAY_COUNT = 12;

export function ClaudeStarburstSpinner({
  size = 22,
  color = "#fb923c",
  duration = "1.2s",
  className = "",
}: ClaudeStarburstSpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }}
      aria-hidden="true"
    >
      <style>
        {`@keyframes ca-ray { 0%,100% { opacity: 0.15 } 15% { opacity: 1 } 50% { opacity: 0.4 } }`}
      </style>
      {Array.from({ length: RAY_COUNT }).map((_, i) => (
        <rect
          key={i}
          x="11"
          y="1.6"
          width="2"
          height="6.2"
          rx="1"
          fill={color}
          transform={`rotate(${(i * 360) / RAY_COUNT} 12 12)`}
          style={{
            transformOrigin: "12px 12px",
            animation: `ca-ray ${duration} linear infinite`,
            animationDelay: `${-i * (1.2 / RAY_COUNT)}s`,
          }}
        />
      ))}
    </svg>
  );
}
