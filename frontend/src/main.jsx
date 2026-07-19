import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { applyAppearancePreferences, loadAppearancePreferences } from './utils/appearancePreferences'

// Apply saved theme/font preferences before first paint to avoid a flash.
applyAppearancePreferences()

// App-level sync: follow OS light/dark changes (for theme 'system') and
// preference changes made in other tabs, regardless of which page is open.
const reapply = () => applyAppearancePreferences(loadAppearancePreferences())
window.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener?.('change', reapply)
window.addEventListener('storage', reapply)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
