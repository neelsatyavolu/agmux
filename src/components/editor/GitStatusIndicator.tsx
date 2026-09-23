interface Props {
  statusCode: string | undefined;
  isDirectory?: boolean;
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  M: { label: "M", color: "text-amber-400" },
  A: { label: "A", color: "text-green-400" },
  D: { label: "D", color: "text-red-400" },
  R: { label: "R", color: "text-blue-400" },
  "?": { label: "U", color: "text-zinc-500" },
  "??": { label: "U", color: "text-zinc-500" },
  AM: { label: "M", color: "text-amber-400" },
  MM: { label: "M", color: "text-amber-400" },
};

export function GitStatusIndicator({ statusCode, isDirectory }: Props) {
  if (!statusCode) return null;
  const config =
    STATUS_CONFIG[statusCode] ?? STATUS_CONFIG[statusCode[0]] ?? null;
  if (!config) return null;
  if (isDirectory) {
    return <span className={`ml-auto text-[8px] ${config.color}`}>●</span>;
  }
  return (
    <span className={`ml-auto text-[10px] font-mono ${config.color}`}>
      {config.label}
    </span>
  );
}
