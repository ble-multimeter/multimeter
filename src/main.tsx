import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './index.css';
import App from './App';

// HashRouter (not BrowserRouter): a GitHub Pages project subpath has no SPA fallback, so deep
// links / refresh to /multimeter/recordings would 404 before the service worker is cached. Hash
// routing keeps every route on the one index.html, so bookmarks and the Back button work
// everywhere with zero Pages config. Routes live after the # (…/multimeter/#/recordings).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
