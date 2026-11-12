import React from 'react'
import ReactDOM from 'react-dom/client'
import { initTelemetry } from './services/telemetry.js'
import { ErrorBoundary, ErrorFallback } from './components/error/ErrorBoundary'
import App from './App'
import { ThemeProvider } from './hooks/theme'
import './styles/globals.css'

// The workbench is a dedicated WebView (?view=workbench). It deliberately does
// NOT mount App's AuthProvider / AuthGate / RemoteConfigProvider: those issue
// network probes on mount, and a hung probe was the cause of the Preferences
// white screen. The workbench only needs the local scan IPC, so keep its boot
// path free of telemetry and remote config entirely.
const Workbench = React.lazy(() => import('./views/Workbench'))
const isWorkbenchWindow = new URLSearchParams(window.location.search).get('view') === 'workbench'
import { logger } from './utils/logger.js'
import posthog from './services/posthog.js'

// Expose React and ReactDOM for plugins
window.React = React;
window.ReactDOM = ReactDOM;

// Initialize crash reporting. initTelemetry only pulls the SDK in when
// VITE_ENABLE_CRASH_REPORTS is set, so with it off the ~390 KB Sentry bundle
// stays out of the boot payload entirely instead of being downloaded and
// parsed on every launch to do nothing.
if (!isWorkbenchWindow) initTelemetry({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || 'development',
  // Performance Monitoring
  tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0, // 10% in production, 100% in dev
  // Session Replay
  replaysSessionSampleRate: 0.1, // 10% of sessions
  replaysOnErrorSampleRate: 1.0, // 100% of sessions with errors
  beforeSend(event) {
    // Filter out known noisy errors
    if (event.exception) {
      const errorMessage = event.exception.values?.[0]?.value || '';
      // Filter out WebView2 cleanup warnings
      if (errorMessage.includes('WebView2')) {
        return null;
      }
    }
    return event;
  },
}).then((sdk) => {
  logger.info('Main', sdk ? 'Sentry SDK initialized successfully' : 'Crash reporting disabled');
});

// Initialize PostHog analytics (skipped in the workbench window: it must boot
// with zero network dependencies)
if (!isWorkbenchWindow) posthog.initialize().catch(err => {
  console.warn('[PostHog] Initialization failed:', err);
});

import { RemoteConfigProvider } from './contexts/RemoteConfigContext'

const root = ReactDOM.createRoot(document.getElementById("root"));

if (isWorkbenchWindow) {
  document.documentElement.classList.add('wb-window');
  root.render(
    <React.StrictMode>
      <ErrorBoundary
        fallback={ErrorFallback}
        showDialog={false}
        onError={(error, errorInfo) => {
          logger.error('ErrorBoundary', 'Workbench error:', error, errorInfo);
        }}
      >
        <React.Suspense fallback={<div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: '#fff', color: '#303236', font: '13px sans-serif' }}>正在加载工作台…</div>}>
          <Workbench />
        </React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary
        fallback={ErrorFallback}
        showDialog={false}
        onError={(error, errorInfo) => {
          logger.error('ErrorBoundary', 'React Error Boundary caught:', error, errorInfo);
        }}
      >
        <RemoteConfigProvider>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </RemoteConfigProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}