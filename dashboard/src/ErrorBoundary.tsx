// Catches a crash in any page, so the user sees a clear recovery screen instead of a blank page.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard crash:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center p-6" role="alert">
        <div className="max-w-md space-y-3 rounded-lg border bg-card p-6">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">The page stopped working. Your data is safe. Reload to continue.</p>
          <div className="flex gap-2">
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <Button variant="outline" onClick={() => this.setState({ error: null })}>Try again</Button>
          </div>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">Technical details</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">{this.state.error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}
