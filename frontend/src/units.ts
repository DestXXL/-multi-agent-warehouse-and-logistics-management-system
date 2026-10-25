const russianNumber = new Intl.NumberFormat('ru-RU')

export function formatMillimeters(value: number): string {
  if (!Number.isFinite(value)) return '–'
  const fractionalMillimeter = Math.abs(value % 10) > 0
  return (value / 1000).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: fractionalMillimeter ? 3 : 2,
  })
}

export function millimetersFromMeters(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) : 0
}

export function meterInputValue(value: number): string {
  return Number.isFinite(value) ? (value / 1000).toFixed(3) : '0.000'
}

export function formatDimensions(lengthMm: number, widthMm: number, heightMm: number): string {
  return `${formatMillimeters(lengthMm)} × ${formatMillimeters(widthMm)} × ${formatMillimeters(heightMm)} м`
}

export function formatCoordinates(xMm: number, yMm: number): string {
  return `(${formatMillimeters(xMm)}; ${formatMillimeters(yMm)}) м`
}

export function formatSquareMillimeters(value: number): string {
  if (!Number.isFinite(value)) return '–'
  return `${(value / 1_000_000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} м²`
}

export function occupancyPercent(occupied: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, occupied / total * 100)) : 0
}

export function formatPercent(value: number): string {
  return russianNumber.format(Number(value.toFixed(1)))
}
