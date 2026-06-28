import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
// KaTeX stylesheet for rendered LaTeX math (see RichText). Imported at the app
// entry (not in the RichText component) so component tests don't pull a CSS
// import into the test DOM, which breaks rendering under happy-dom.
import 'katex/dist/katex.min.css';

const el = document.getElementById('root');
if (!el) throw new Error('root element missing');
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
);
