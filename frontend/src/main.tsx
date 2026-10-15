import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import LayoutEditor from './LayoutEditor'
import './style.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get('view') === 'layout' ? <LayoutEditor /> : <App />}
  </React.StrictMode>,
)
