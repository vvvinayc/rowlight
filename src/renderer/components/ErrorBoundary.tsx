// Catches a rendering error so one broken part shows a message instead of turning the whole window blank.
// The error is also written to the log file (userData/logs/renderer.log) for bug reports.

import React from 'react';
import { api } from '../api';

interface Props { children: React.ReactNode; label: string; onReset?: () => void }
interface State { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    api.logError?.(`[${this.props.label}] ${error.stack ?? error.message}\n${info.componentStack ?? ''}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const text = `${this.props.label}: ${error.message}`;
    return (
      <div className="error-boundary">
        <b>Something went wrong in the {this.props.label}.</b>
        <pre>{error.message}</pre>
        <div className="modal-actions">
          <button onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>Try again</button>
          <button onClick={() => api.copyText(text + '\n' + (error.stack ?? ''))}>Copy error</button>
          <span className="muted small">Details were saved to the log file. Your query text is safe.</span>
        </div>
      </div>
    );
  }
}
