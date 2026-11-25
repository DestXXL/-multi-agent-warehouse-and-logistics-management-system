import type { Lane } from './TrafficMarkings'

type Point = [number, number]
type Floor = {
  width: number; height: number; obstacles: Point[]; closed_cells: Point[]
  lanes?: Lane[]; racks: { position: Point; service_point: Point | null }[]
  robots: { home: Point }[]
}

// Trace two-way access from the traffic lanes to the working faces of the racks.
export function serviceAisles(floor: Floor) {
  const { width, height } = floor
  const id = ([x, y]: Point) => y * width + x
  const point = (i: number): Point => [i % width, Math.floor(i / width)]
  const valid = ([x, y]: Point) => x >= 0 && y >= 0 && x < width && y < height
  const blocked = new Set([...floor.obstacles, ...floor.closed_cells, ...floor.racks.map(r => r.position)].map(id))
  const lanes = new Map(floor.lanes?.map(l => [id([l.x, l.y]), l.direction]))
  const roots = lanes.size ? [...lanes.keys()] : floor.robots.map(r => id(r.home))
  const queue = [...new Set(roots)].filter(i => !blocked.has(i))
  const parent = new Map(queue.map(i => [i, i]))
  const distance = new Map(queue.map(i => [i, 0]))
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i], [x, y] = point(from)
    const lane = lanes.get(from)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // Only a lateral junction allows both entry and exit at the same point.
      if (lane && ((lane === 'east' || lane === 'west') ? dx !== 0 : dy !== 0)) continue
      const next: Point = [x + dx, y + dy], key = id(next)
      if (!valid(next) || blocked.has(key) || parent.has(key)) continue
      parent.set(key, from)
      distance.set(key, distance.get(from)! + 1)
      queue.push(key)
    }
  }

  const edges = new Set<string>()
  const path: string[] = []
  const join = (a: number, b: number) => {
    const key = Math.min(a,b) + ':' + Math.max(a,b)
    if (edges.has(key)) return
    edges.add(key)
    const [x,y] = point(a), [u,v] = point(b)
    path.push(`M${x+.5} ${y+.5}L${u+.5} ${v+.5}`)
  }
  const stops = new Set<number>()
  for (const rack of floor.racks) {
    const [x, y] = rack.position
    const faces: Point[] = [[x,y-1], [x,y+1]]
    const options = faces.filter(p => valid(p) && parent.has(id(p)))
    options.sort((a,b) => distance.get(id(a))! - distance.get(id(b))!)
    if (options.length) stops.add(id(options[0]))
  }
  // Consecutive pickup points along a shelf row share one continuous aisle.
  for (const stop of stops) {
    if (stop % width !== width-1 && stops.has(stop+1) && !lanes.has(stop) && !lanes.has(stop+1)) join(stop,stop+1)
  }
  // Connect each continuous row once, at its nearest junction.
  const visited = new Set<number>()
  for (const stop of stops) {
    if (visited.has(stop)) continue
    let entry = stop, current = stop
    while (current % width && edges.has((current-1)+':'+current)) current--
    while (true) {
      visited.add(current)
      if (distance.get(current)! < distance.get(entry)!) entry = current
      if (!edges.has(current+':'+(current+1))) break
      current++
    }
    while (parent.get(entry) !== entry) {
      const previous = parent.get(entry)!
      join(entry, previous)
      entry = previous
    }
  }
  return { path: path.join(' '), stops: [...stops].map(point) }
}
