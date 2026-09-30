import React from 'react';
import ReactDOM from 'react-dom/client';
import Home from './App.tsx';
import './index.css';
import 'uplot/dist/uPlot.min.css';
import 'react-toastify/dist/ReactToastify.css';
import { setModelProxyFetch } from '../agent/model/client';
import { modelFetch } from './lib/lease';

// Every model call carries this browser's token, as storage requests do (docs/14 §1.2), and the
// lease of the world it is for (§3.3).
setModelProxyFetch(modelFetch);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Home />
  </React.StrictMode>,
);
