/// <reference types="vite/client" />
export const serverUrl = `http://${window.location.hostname}:${import.meta.env.VITE_API_PORT || '8000'}`
