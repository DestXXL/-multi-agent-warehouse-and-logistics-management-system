"""Directional aisles allow crossing and turns, but prohibit travel against arrows."""
from backend.models import Point

DIRECTIONS = {"east": (1, 0), "west": (-1, 0), "north": (0, -1), "south": (0, 1)}


def permits(lanes: dict, start: Point, end: Point) -> bool:
    dx, dy = end[0] - start[0], end[1] - start[1]
    # Adjacent opposing lanes form a divided carriageway; cross at a break in the markings.
    if start in lanes and end in lanes:
        a, b = DIRECTIONS[lanes[start]], DIRECTIONS[lanes[end]]
        if a == (-b[0], -b[1]) and dx * a[0] + dy * a[1] == 0:
            return False
    for point in (start, end):
        if point in lanes:
            x, y = DIRECTIONS[lanes[point]]
            if dx * x + dy * y < 0:
                return False
    return True


def road_network(warehouse):
    """Connect marked lanes, loading faces, docks and parking on the static floor."""
    from heapq import heappop, heappush
    from backend.models import rack_pickup_faces

    lanes = warehouse.lanes
    blocked = set(warehouse.obstacles) | {r.position for r in warehouse.racks}
    edges = set()
    stops = set()

    def join(a, b):
        edges.add((a, b))
        edges.add((b, a))

    def tree(roots, reverse=False):
        parent = {p: p for p in roots}
        dist = {p: 0 for p in roots}
        queue = [(0, p) for p in sorted(roots)]
        while queue:
            cost, p = heappop(queue)
            if cost != dist[p]:
                continue
            for dx, dy in DIRECTIONS.values():
                q = p[0] + dx, p[1] + dy
                if q in blocked or not (0 <= q[0] < warehouse.width and 0 <= q[1] < warehouse.height):
                    continue
                a, b = (q, p) if reverse else (p, q)
                if not permits(lanes, a, b):
                    continue
                score = cost + (1 if p in lanes and q in lanes else 4)
                if score < dist.get(q, float('inf')):
                    dist[q], parent[q] = score, p
                    heappush(queue, (score, q))
        return parent, dist

    def trace(p, parent):
        while p in parent and parent[p] != p:
            join(p, parent[p])
            p = parent[p]

    if lanes:
        for p, direction in lanes.items():
            dx, dy = DIRECTIONS[direction]
            q = p[0] + dx, p[1] + dy
            if q in lanes and permits(lanes, p, q):
                join(p, q)
        for reverse in (False, True):
            links, _ = tree([min(lanes)], reverse)
            for p in lanes:
                trace(p, links)
        outward, distances = tree(lanes)
        inward, _ = tree(lanes, reverse=True)
        for rack in warehouse.racks:
            faces = [p for p in rack_pickup_faces(rack.position) if p in outward and p in inward]
            if faces:
                stops.add(min(faces, key=distances.get))
        for x, y in stops:
            if (x+1, y) in stops:
                join((x, y), (x+1, y))
        terminals = stops | set(warehouse.shipping_points) | {r.home for r in warehouse.robots}
        for p in terminals:
            trace(p, outward)
            trace(p, inward)
    return edges, stops
