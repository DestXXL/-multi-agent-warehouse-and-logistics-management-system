import type { Rack } from './App'
type AisleLabel = { widthM: number; gapCells: number; fitsForklift: boolean }
function key([x,y]: [number,number]) { return `${x},${y}` }

export function findAisleLabels(warehouse: { racks: Rack[]; obstacles: [number, number][] } | undefined, cellStepM: number, forkliftWidthM: number) {
  const labels = new Map<string, AisleLabel>()
  if (!warehouse?.racks?.length) return labels
  const blocked = new Set(warehouse.obstacles.map(key))

  const addGap = (first: Rack, second: Rack, axis: 'x' | 'y') => {
    const firstCoordinate = first.position[axis === 'x' ? 0 : 1]
    const secondCoordinate = second.position[axis === 'x' ? 0 : 1]
    const gapCells = secondCoordinate - firstCoordinate
    if (gapCells <= 1) return
    for (let coordinate = firstCoordinate + 1; coordinate < secondCoordinate; coordinate += 1) {
      const point: [number, number] = axis === 'x' ? [coordinate, first.position[1]] : [first.position[0], coordinate]
      if (blocked.has(key(point))) return
    }
    const center: [number, number] = axis === 'x'
      ? [Math.floor((firstCoordinate + secondCoordinate) / 2), first.position[1]]
      : [first.position[0], Math.floor((firstCoordinate + secondCoordinate) / 2)]
    const firstSpanM = (axis === 'x' ? first.width_mm : first.depth_mm) / 1000
    const secondSpanM = (axis === 'x' ? second.width_mm : second.depth_mm) / 1000
    const widthM = Math.max(0, gapCells * cellStepM - (firstSpanM + secondSpanM) / 2)
    const label = { widthM, gapCells: gapCells - 1, fitsForklift: widthM >= forkliftWidthM }
    const existing = labels.get(key(center))
    if (!existing || label.widthM < existing.widthM) labels.set(key(center), label)
  }

  const rows = new Map<number, Rack[]>()
  const columns = new Map<number, Rack[]>()
  warehouse.racks.forEach(rack => {
    const row = rows.get(rack.position[1]) ?? []
    row.push(rack)
    rows.set(rack.position[1], row)
    const column = columns.get(rack.position[0]) ?? []
    column.push(rack)
    columns.set(rack.position[0], column)
  })
  rows.forEach(racks => {
    const sorted = racks.slice().sort((a, b) => a.position[0] - b.position[0])
    for (let index = 1; index < sorted.length; index += 1) addGap(sorted[index - 1], sorted[index], 'x')
  })
  columns.forEach(racks => {
    const sorted = racks.slice().sort((a, b) => a.position[1] - b.position[1])
    for (let index = 1; index < sorted.length; index += 1) addGap(sorted[index - 1], sorted[index], 'y')
  })
  const compacted = new Map<string, AisleLabel>()
  const pending = new Set(labels.keys())
  while (pending.size) {
    const start = pending.values().next().value as string
    const reference = labels.get(start)!
    const group: string[] = []
    const queue = [start]
    pending.delete(start)
    while (queue.length) {
      const current = queue.shift()!
      group.push(current)
      const [x, y] = current.split(',').map(Number)
      for (const neighbor of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
        const candidate = labels.get(neighbor)
        if (pending.has(neighbor) && candidate && candidate.fitsForklift === reference.fitsForklift && Math.abs(candidate.widthM - reference.widthM) < 0.25) {
          pending.delete(neighbor)
          queue.push(neighbor)
        }
      }
    }
    group.sort((first, second) => {
      const [firstX, firstY] = first.split(',').map(Number)
      const [secondX, secondY] = second.split(',').map(Number)
      return firstY - secondY || firstX - secondX
    })
    const center = group[Math.floor(group.length / 2)]
    compacted.set(center, labels.get(center)!)
  }
  return compacted
}

