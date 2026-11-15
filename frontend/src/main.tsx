import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import LayoutEditor from './LayoutEditor'
import './style.css'
import './typography.css'
import './rack-details.css'
import './control-center.css'
import './responsive.css'
import './rack-modal.css'
import './design-showcase.css'

document.documentElement.dataset.design = 'artdeco'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('view') === 'layout' ? <LayoutEditor /> : <App />}
  </React.StrictMode>,
)
