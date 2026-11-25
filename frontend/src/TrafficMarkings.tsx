export type Lane = { x: number; y: number; direction: 'east' | 'west' | 'north' | 'south' }

type Strip = { horizontal: boolean; across: number; start: number; end: number; sign: number }

// Merge only consecutive marks. An unmarked crossing always breaks the painted line.
function joinStrips(strips: Strip[]) {
  const result: Strip[] = []
  strips.sort((a, b) => Number(a.horizontal) - Number(b.horizontal) || a.across - b.across || a.sign - b.sign || a.start - b.start)
  for (const strip of strips) {
    const last = result[result.length - 1]
    if (last && last.horizontal === strip.horizontal && last.across === strip.across && last.sign === strip.sign && last.end === strip.start) last.end = strip.end
    else result.push(strip)
  }
  return result
}

export default function TrafficMarkings({ lanes, unit }: { lanes: Lane[]; unit: number }) {
  const directions = new Map(lanes.map(lane => [lane.x + ',' + lane.y, lane.direction]))
  const strips: Strip[] = [], dividers: Strip[] = []
  for (const {x, y, direction} of lanes) {
    const horizontal = direction === 'east' || direction === 'west'
    const sign = direction === 'east' || direction === 'south' ? 1 : -1
    const start = horizontal ? x : y
    const across = horizontal ? y : x
    const strip = { horizontal, sign, start, end: start + 1, across: across + 0.5 }
    strips.push(strip)
    const adjacent = horizontal ? directions.get(x + ',' + (y+1)) : directions.get((x+1) + ',' + y)
    const opposite = {east:'west', west:'east', south:'north', north:'south'}[direction]
    if (adjacent === opposite) dividers.push({...strip, sign: 0, across: across + 1})
  }
  return <g pointerEvents="none" aria-hidden="true" className="traffic-markings" transform={`scale(${unit})`}>
    {joinStrips(strips).map(({horizontal, across, start, end, sign}) => {
      const length = end - start
      const arrows = Math.max(1, Math.ceil(length / 5))
      return <g key={[horizontal, across, start].join('/')} transform={horizontal ? `translate(${start} ${across})` : `translate(${across} ${start}) rotate(90)`}>
        <path d={`M0 0H${length}`} stroke="var(--muted)" strokeOpacity=".12" strokeWidth="1"/>
        {Array.from({length: arrows}, (_,i) => <path key={i} transform={`translate(${(i+.5)*length/arrows} 0) scale(${sign} 1)`} d="M-.22 -.035 H.035 V-.13 L.24 0 .035 .13 V.035 H-.22 Z" fill="var(--muted)" />)}
      </g>
    })}
    {joinStrips(dividers).map(({horizontal, across, start, end}) => <path key={[horizontal, across, start].join('/')} d={horizontal ? `M${start} ${across}H${end}` : `M${across} ${start}V${end}`} stroke="var(--accent)" strokeWidth=".055"/>)}
  </g>
}
