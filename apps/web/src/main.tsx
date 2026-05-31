import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ConfirmProvider } from './lib/confirm'
import { initStyledTooltips } from './lib/styledTooltips'
import './index.css'

// Strip native browser `title` tooltips on .btn-ghost buttons so
// only the styled CSS tooltip (index.css) shows on hover.
initStyledTooltips()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </BrowserRouter>
  </StrictMode>,
)
