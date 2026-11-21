import './monacoSetup';
import './styles.css';
import { applyTheme } from './theme';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

applyTheme(); // before the first paint, so there is no flash of the wrong theme
createRoot(document.getElementById('root')!).render(<App />);
