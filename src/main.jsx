import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import i18n from './i18n.js'
import { getPreference } from './db/indexedDB'

async function startApp() {
  const savedLanguage = await getPreference('userLang');
  if (savedLanguage) await i18n.changeLanguage(savedLanguage);

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

startApp();
