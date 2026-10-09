import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { agent } from './lib/agent';
import { ensureAutostart, isDesktopApp } from './lib/native';
import './styles.css';

document.documentElement.dataset.desktop = isDesktopApp() ? '1' : '0';

// Kiosk behaviour: no context menu, no accidental zoom/navigation shortcuts in the webview.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    ['r', 'p', 'u', 's', 'f', '+', '-', '0'].includes(e.key.toLowerCase()) &&
    !e.altKey
  )
    e.preventDefault();
  if (e.key === 'F5' || e.key === 'F12') e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void agent.start();
void ensureAutostart();
