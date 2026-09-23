import { CheckCircle2, Loader2, AlertCircle, Info } from "lucide-react";
import type { TaskNotification } from "../../lib/messageFilters";

interface Props {
  notification: TaskNotification;
}

function statusStyle(status: string): {
  dot: string;
  icon: React.ReactNode;
} {
  switch (status.toLowerCase()) {
    case "completed":
      return {
        dot: "bg-green-500",
        icon: <CheckCircle2 size={12} className="text-green-400" />,
      };
    case "running":
      return {
        dot: "bg-amber-500",
        icon: <Loader2 size={12} className="text-amber-400 animate-spin" />,
      };
    case "error":
    case "failed":
      return {
        dot: "bg-red-500",
        icon: <AlertCircle size={12} className="text-red-400" />,
      };
    default:
      return {
        dot: "bg-blue-500",
        icon: <Info size={12} className="text-blue-400" />,
      };
  }
}

export function TaskNotificationBadge({ notification }: Props) {
  const { dot, icon } = statusStyle(notification.status);

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {icon}
      <span className="font-medium capitalize">{notification.status}</span>
      {notification.summary && (
        <>
          <span className="text-zinc-500">·</span>
          <span className="text-zinc-400">{notification.summary}</span>
        </>
      )}
    </div>
  );
}
