import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Phones: follow the *visible* viewport, not the layout viewport. On iOS the
// keyboard is drawn over the page without shrinking it, so anything docked to
// the bottom (the ticket reply box) ends up underneath it. Publishing the
// visual viewport height as --app-vh lets the app shrink instead; index.css
// consumes it below the lg breakpoint.
(function trackVisualViewport() {
  const vv = typeof window !== 'undefined' && window.visualViewport;
  if (!vv) return;
  const apply = () => document.documentElement.style.setProperty('--app-vh', `${Math.round(vv.height)}px`);
  apply();
  vv.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
