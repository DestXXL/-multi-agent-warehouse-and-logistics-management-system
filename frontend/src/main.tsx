import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import DialogResizeHandles from './DialogResizeHandles'
import LayoutEditor from './LayoutEditor'
import './style.css'
import './typography.css'
import './rack-details.css'
import './control-center.css'
import './responsive.css'
import './rack-modal.css'
import './warehouse-ui.css'

document.documentElement.dataset.theme = localStorage.getItem('warehouse-theme') === 'light' ? 'light' : 'dark'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><DialogResizeHandles />
    {new URLSearchParams(window.location.search).get('view') === 'layout' ? <LayoutEditor /> : <App />}
  </React.StrictMode>,
)
