// The closest empty gate to you.
//
//   closestEmptyGate({ me, aircraft, labels }) -> { name: "7", icao: "IRFD", dist } or null
//
// me       = your aircraft from the radar ({ position: { x, y } })
// aircraft = every aircraft on the server ({ callsign: { position, isOnGround, groundSpeed } })
// labels   = the radar's taxi-labels.json ({ ICAO: { labels: [[x, y, angle, "7"], ...] } });
//            the number labels are gate / stand numbers, placed from the ground charts
//
// A gate counts as taken when a plane is sitting on the ground near it.
const NEAR_AIRPORT = 4000; // studs: only gates at the airport you're at
const TAKEN = 140;         // studs: a parked plane this close to a gate's number takes it

export function closestEmptyGate({ me, aircraft = {}, labels = {}, myCallsign = "" } = {}) {
  const p = me?.position;
  if (!p) return null;
  const parked = Object.entries(aircraft || {})
    .filter(([cs, a]) => cs !== myCallsign && a?.position && a.isOnGround && (a.groundSpeed || 0) < 5)
    .map(([, a]) => a.position);
  // Gates at the airport you're at.
  const gates = [];
  for (const [icao, data] of Object.entries(labels || {})) {
    for (const [x, y, , name] of data.labels || data || []) {
      if (!/^\d{1,3}[A-Z]?$/.test(name)) continue;                 // gate numbers only
      const dist = Math.hypot(x - p.x, y - p.y);
      if (dist <= NEAR_AIRPORT) gates.push({ name, icao, x, y, dist });
    }
  }
  // Each parked plane takes the one gate nearest to it (gates can be close together).
  const taken = new Set();
  for (const q of parked) {
    let g = null, gd = TAKEN;
    for (const gate of gates) { const d = Math.hypot(q.x - gate.x, q.y - gate.y); if (d < gd) { gd = d; g = gate; } }
    if (g) taken.add(g);
  }
  let best = null;
  for (const g of gates) if (!taken.has(g) && (!best || g.dist < best.dist)) best = g;
  return best ? { name: best.name, icao: best.icao, dist: Math.round(best.dist) } : null;
}
