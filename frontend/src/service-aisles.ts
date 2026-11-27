type Point = [number, number]
type Floor = {
  width: number; height: number; obstacles: Point[]; closed_cells: Point[]
  racks: { position: Point }[]; roads?: { edges: [Point, Point][]; stops: Point[] }
}

// Mark the perimeter of each storage island, leaving adjacent rack bays joined.
export function floorMarkings(floor: Floor) {
  const racks = new Set(floor.racks.map(r => r.position.join(',')))
  const unavailable = new Set([...floor.obstacles, ...floor.closed_cells].map(p => p.join(',')))
  const stops = new Map<string, Point>()
  const designated = floor.roads && new Set(floor.roads.stops.map(p => p.join(',')))
  const perimeter: string[] = [], fill: string[] = []
  for (const {position: [x, y]} of floor.racks) {
    fill.push(`M${x} ${y}h1v1h-1z`)
    if (!racks.has([x-1,y].join(','))) perimeter.push(`M${x} ${y}v1`)
    if (!racks.has([x+1,y].join(','))) perimeter.push(`M${x+1} ${y}v1`)
    for (const dy of [-1, 1]) {
      const ny = y + dy, key = [x, ny].join(',')
      if (racks.has(key)) continue
      perimeter.push(`M${x} ${dy < 0 ? y : y+1}h1`)
      if (ny >= 0 && ny < floor.height && !unavailable.has(key) && (!designated || designated.has(key))) {
        stops.set(key, [x, ny])
      }
    }
  }
  return {
    storage: fill.join(' '), perimeter: perimeter.join(' '), stops: [...stops.values()],
    road: floor.roads?.edges.map(([[x,y],[u,v]]) => `M${x+.5} ${y+.5}L${u+.5} ${v+.5}`).join(' ') ?? '',
  }
}
