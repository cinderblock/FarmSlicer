import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { reportError } from "../errorReporting";

interface Props {
  children: ReactNode;
  /** A change (the page's path) clears the error: navigating away recovers. */
  resetKey?: string;
  /** Fill the window (around the whole app) rather than the content area. */
  fullPage?: boolean;
}

interface State {
  error: Error | null;
  resetKey?: string;
}

/** Catches render errors below it, reports them (with the component stack)
 *  and shows a way out instead of a blank page. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError(error, "react", { component_stack: info.componentStack?.slice(0, 4000) ?? null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const panel = (
      <div className="error-fallback" role="alert">
        <h3>Something went wrong{this.props.fullPage ? "" : " on this page"}</h3>
        <p className="hint">
          The error was reported automatically. Reloading usually gets things going again; if it keeps happening, the
          Feedback button is the place to tell us what you were doing.
        </p>
        <pre className="error-fallback-detail">{`${error.name}: ${error.message}`}</pre>
        <div className="error-fallback-actions">
          <button className="btn-primary btn-inline" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
    return this.props.fullPage ? <div className="login-page">{panel}</div> : panel;
  }
}
