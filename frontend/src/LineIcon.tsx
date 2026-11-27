const paths = {
  orders: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  fleet: 'M2 17V6h12v11m0-7h4l4 4v3h-3M2 17h2m4 0h7M8 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm11 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  stock: 'M3 7l9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4m-9 4v10M8 5l9 4',
  control: 'M4 7h4m4 0h8M4 17h8m4 0h4M8 4v6m8 4v6',
  agents: 'M12 8v8M5 16v-4h14v4M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6z',
  events: 'M4 5h16M4 12h16M4 19h10',
  object: 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6m-3-12v6m-3-3h6',
  speed: 'm4 7 7 5-7 5V7Zm9 0 7 5-7 5V7Z',
  moon: 'M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5Z',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
}

export function LineIcon({ kind }: { kind: keyof typeof paths }) {
  return <svg className="line-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>
}
