import './monacoSetup';
import './styles.css';
import { applyTheme } from './theme';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { api } from './api';

applyTheme(); // before the first paint, so there is no flash of the wrong theme
// Uncaught errors go to userData/logs/renderer.log (helps with "the window went blank" reports).
window.addEventListener('error', (e) => api.logError?.('[window] ' + (e.error?.stack ?? e.message)));
window.addEventListener('unhandledrejection', (e) => api.logError?.('[promise] ' + ((e.reason as Error)?.stack ?? String(e.reason))));
createRoot(document.getElementById('root')!).render(<ErrorBoundary label="app"><App /></ErrorBoundary>);
