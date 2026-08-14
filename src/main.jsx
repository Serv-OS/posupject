import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Phones: when the KEYBOARD is up, shrink the app to the visible viewport so
// bottom-docked UI (the ticket reply box) sits above it instead of underneath.
//
// The first version of this reacted to EVERY visual-viewport change. On a
// phone, scrolling itself changes the visual viewport — the URL bar retracts
// and returns, firing resize continuously — so the app's height was being
// re-pinned mid-scroll and every screen fought the finger. Only a keyboard is
// worth reacting to, and a keyboard takes hundreds of pixels; the URL bar
// takes tens. Below the threshold the property is REMOVED, so height falls
// back to the plain 100% it always was.
(function trackVisualViewport() {
  const vv = typeof window !== 'undefined' && window.visualViewport;
  if (!vv) return;
  const KEYBOARD_MIN_PX = 150;
  const apply = () => {
    // vv.height is in *scaled* pixels: on a phone zoomed for bigger fonts (or
    // pinch-zoomed) it reads far smaller than the window even with no keyboard
    // anywhere. Comparing it raw read zoom as "keyboard open" and squashed the
    // app into a sliver — "the scroll box is barely visible". Multiplying by
    // the scale compares like with like: zoom cancels out, a keyboard doesn't.
    const scale = vv.scale || 1;
    const gap = window.innerHeight - vv.height * scale;
    if (gap > KEYBOARD_MIN_PX && scale <= 1.05) {
      document.documentElement.style.setProperty('--app-vh', `${Math.round(vv.height)}px`);
    } else {
      document.documentElement.style.removeProperty('--app-vh');
    }
  };
  apply();
  vv.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
