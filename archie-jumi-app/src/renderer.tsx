import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { createPreviewAdapter } from './preview/adapter';
import { startOverlay } from './rendering/overlay';
import './ui/styles.css';
const view = new URLSearchParams(location.search).get('view') ?? 'settings';
const adapter = window.desktop ?? createPreviewAdapter();
if (view === 'overlay') {
  void startOverlay(adapter).catch(error => {
    const message = document.createElement('div'); message.dataset.error = 'true'; message.textContent = `Could not start the kittens: ${error instanceof Error ? error.message : String(error)}`;
    message.style.cssText = 'background:#fff4e7;color:#6e3040;padding:20px;border-radius:16px;max-width:400px;font:16px Segoe UI';
    document.getElementById('root')!.append(message);
    // No ready message: the native window remains hidden and click-through.
  });
} else createRoot(document.getElementById('root')!).render(<App adapter={adapter} />);
