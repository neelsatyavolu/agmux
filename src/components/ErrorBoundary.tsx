import { SupportSection } from "./settings/SupportSection";
import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  support?: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    document.getElementById("splash")?.remove();
    console.error("agmux caught an error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.state.support) return <div className="h-screen overflow-auto bg-[var(--bg-app)] p-8 text-text-primary"><div className="mx-auto max-w-xl"><button className="mb-4 text-sm" onClick={() => this.setState({ support: false })}>Back to error</button><SupportSection initialDetails={`${this.state.error?.message ?? ""}\n\n${this.state.error?.stack ?? ""}`} /></div></div>;
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--bg-app)] p-8">
          <div className="rounded-2xl border border-red-500/30 bg-red-950/20 p-6 max-w-lg w-full fx-card">
            <h2 className="mb-2 text-lg font-semibold text-red-400">
              Something went wrong
            </h2>
            <p className="mb-4 text-sm text-zinc-400">
              agmux encountered an unexpected error. Try reloading the app.
            </p>
            {this.state.error?.message ? (
              <p className="mb-4 text-sm text-zinc-300">{this.state.error.message}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => this.setState({ support: true })} className="rounded border border-white/10 px-4 py-2 text-sm fx-quiet">Contact Support</button>
              <button
                onClick={() => window.location.reload()}
                className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 fx-accent"
              >
                Reload App
              </button>
              {this.state.error?.stack ? (
                <button
                  onClick={() => {
                    const text = `${this.state.error?.message ?? ""}\n\n${this.state.error?.stack ?? ""}`;
                    void navigator.clipboard.writeText(text).catch(() => {});
                  }}
                  className="rounded border border-white/10 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-white/5 fx-quiet"
                >
                  Copy details
                </button>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
