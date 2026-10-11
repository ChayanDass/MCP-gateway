// Catches a crash in any page, so the user sees a clear recovery screen instead of a blank page.
import { Component, type ErrorInfo, type ReactNode } from "react";

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
      <div className="fatal" role="alert">
        <div className="fatal-card">
          <h1>Something went wrong</h1>
          <p className="muted">The page stopped working. Your data is safe. Reload to continue.</p>
          <div className="fatal-actions">
            <button className="primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="ghost" onClick={() => this.setState({ error: null })}>Try again</button>
          </div>
          <details className="fatal-details">
            <summary>Technical details</summary>
            <pre>{this.state.error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}
