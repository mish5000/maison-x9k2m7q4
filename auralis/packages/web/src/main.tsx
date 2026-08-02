import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles/tokens.css';
import './styles/global.css';
import './styles/layout.css';
import './styles/search.css';
import './styles/results.css';
import './styles/surfaces.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Auralis could not start: the application container is missing.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
