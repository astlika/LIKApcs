/**
 * Entry of the customer display window (`display.html`). A separate, tiny bundle: no router, no
 * auth, no server traffic — everything arrives from the main window (see lib/customer-display).
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { DisplayApp } from './DisplayApp';
import './display.css';

document.documentElement.dataset.theme = 'dark';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <DisplayApp />
  </React.StrictMode>,
);
