/**
 * Animated spinner with Claude's starburst/asterisk shape.
 * 13 arms radiating from center, rotating continuously.
 */

interface ClaudeSpinnerProps {
  size?: number;
  color?: string;
  speed?: string;
  className?: string;
}

export function ClaudeSpinner({
  size = 48,
  color = "currentColor",
  speed = "2s",
  className = "",
}: ClaudeSpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{
        animation: `claude-spin ${speed} linear infinite`,
        transformOrigin: "center",
        display: "inline-block",
        verticalAlign: "middle",
      }}
    >
      <style>
        {`
          @keyframes claude-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}
      </style>
      <g transform="translate(50, 50)">
        <path
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="
            M 0 0 L -3 -32
            M 0 0 L 10 -26
            M 0 0 L 24 -20
            M 0 0 L 34 -4
            M 0 0 L 28 12
            M 0 0 L 18 28
            M 0 0 L 4 30
            M 0 0 L -8 34
            M 0 0 L -22 24
            M 0 0 L -30 8
            M 0 0 L -34 -4
            M 0 0 L -28 -18
            M 0 0 L -16 -26
          "
        />
      </g>
    </svg>
  );
}
