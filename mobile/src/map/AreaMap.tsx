// A simple map of Richards Bay and around, drawn without map tiles so it works offline and costs
// nothing: the main road, landmarks to find your way, and pins with labels. Used for the fleet
// (where every vehicle is) and for a department manager's team (where each technician is).
import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';
import { Choice, st } from '../ui.tsx';
import { C, S } from '../theme.ts';

/** Places to find your way on the map. */
export const LANDMARKS: { name: string; lat: number; lng: number }[] = [
  { name: 'Office yard (Alton)', lat: -28.7499, lng: 32.0507 },
  { name: 'Richards Bay CBD', lat: -28.7606, lng: 32.0420 },
  { name: 'Meerensee', lat: -28.7743, lng: 32.0789 },
  { name: 'Harbour', lat: -28.7990, lng: 32.0720 },
  { name: 'Empangeni', lat: -28.7621, lng: 31.8932 },
  { name: 'Esikhawini', lat: -28.8710, lng: 31.9150 },
];
/** The main road from Empangeni to Richards Bay, roughly. */
const ROAD: [number, number][] = [[-28.7621, 31.8932], [-28.7560, 31.9500], [-28.7520, 32.0000], [-28.7499, 32.0507], [-28.7606, 32.0420], [-28.7743, 32.0789]];

/** Richards Bay itself; pins outside it are listed under the map. */
const TOWN = { s: -28.812, n: -28.738, w: 32.018, e: 32.098 };
export const inTown = (lat: number, lng: number) => lat >= TOWN.s && lat <= TOWN.n && lng >= TOWN.w && lng <= TOWN.e;

/** The nearest landmark, to say roughly where something is. */
export function nearest(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return 'unknown';
  let best = LANDMARKS[0], dist = Infinity;
  for (const l of LANDMARKS) { const d = (l.lat - lat) ** 2 + ((l.lng - lng) * 0.88) ** 2; if (d < dist) { dist = d; best = l; } }
  return best.name;
}

export interface MapPin { id: string; lat: number; lng: number; label: string; colour: string; accessibilityLabel?: string }

export function AreaMap({ pins: all, picked, onPick, label, outsideLabel = 'Out of town:' }: {
  pins: MapPin[]; picked?: string; onPick: (id: string) => void; label: string; outsideLabel?: string;
}) {
  const [w, setW] = useState(0);
  const [zoom, setZoom] = useState<'town' | 'all'>('town');
  const h = Math.max(260, Math.min(460, w * 0.85));
  const shown = zoom === 'all' ? all : all.filter(p => inTown(p.lat, p.lng));
  const outside = all.filter(p => !shown.includes(p));
  const marks = zoom === 'all' ? LANDMARKS : LANDMARKS.filter(l => inTown(l.lat, l.lng));

  // Fit what is shown, keeping the shape right (a degree of longitude is shorter here).
  const proj = useMemo(() => {
    const lats = zoom === 'all' ? [...all.map(p => p.lat), ...LANDMARKS.map(l => l.lat)] : [TOWN.s, TOWN.n];
    const lngs = zoom === 'all' ? [...all.map(p => p.lng), ...LANDMARKS.map(l => l.lng)] : [TOWN.w, TOWN.e];
    const pad = zoom === 'all' ? 0.012 : 0.002;
    let [s0, n0, w0, e0] = [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lngs) - pad, Math.max(...lngs) + pad];
    const k = Math.cos((s0 + n0) / 2 * Math.PI / 180);
    const spanX = (e0 - w0) * k, spanY = n0 - s0;
    const ratio = w / h;
    if (spanX / spanY > ratio) { const extra = (spanX / ratio - spanY) / 2; s0 -= extra; n0 += extra; }
    else { const extra = (spanY * ratio - spanX) / 2 / k; w0 -= extra; e0 += extra; }
    return (lat: number, lng: number) => ({ x: (lng - w0) / (e0 - w0) * w, y: (n0 - lat) / (n0 - s0) * h });
  }, [all.map(p => `${p.lat},${p.lng}`).join('|'), w, h, zoom]);

  // Labels step down when pins stand close together, and flip left at the right edge.
  const placedPins = useMemo(() => {
    const placed: { x: number; y: number }[] = [];
    const dots: { x: number; y: number }[] = [];
    // People or vehicles at the same place sit side by side, not on top of each other.
    const spread = (xy: { x: number; y: number }) => {
      let { x, y } = xy;
      while (dots.some(d => Math.abs(d.x - x) < 22 && Math.abs(d.y - y) < 22)) x += 24;
      dots.push({ x, y });
      return { x, y };
    };
    return shown.map(p => spread(proj(p.lat, p.lng))).map((xy, i) => {
      const spots = [[xy.x + 12, xy.y - 9], [xy.x - 92, xy.y - 9], [xy.x - 40, xy.y + 12], [xy.x - 40, xy.y - 30]].filter(([x]) => x >= 0 && x + 86 <= w);
      const free = (x: number, y: number) => !placed.some(q => Math.abs(q.x - x) < 86 && Math.abs(q.y - y) < 18)
        && !dots.some(d => x < d.x + 11 && x + 86 > d.x - 11 && y < d.y + 11 && y + 18 > d.y - 11);
      let [lx, ly] = spots.find(([x, y]) => free(x, y)) ?? spots[0] ?? [xy.x + 12, xy.y - 9];
      while (!free(lx, ly)) ly += 18;
      placed.push({ x: lx, y: ly });
      return { p: shown[i], ...xy, lx, ly };
    });
  }, [proj, shown.map(p => p.id).join()]);
  const sel = all.find(p => p.id === picked);

  return (
    <>
      <Choice options={['town', 'all'] as const} value={zoom} onChange={setZoom} labels={{ town: 'Richards Bay', all: 'Whole area' }} />
      <View onLayout={e => setW(e.nativeEvent.layout.width)} style={{ height: h, borderRadius: S.radius, overflow: 'hidden', backgroundColor: '#1D2B3A', borderWidth: 1, borderColor: C.line }}
        accessibilityLabel={label}>
        {w > 0 ? (
          <>
            <Svg width={w} height={h} pointerEvents="none">
              <Rect x={0} y={0} width={w} height={h} fill="#1D2B3A" />
              {ROAD.slice(1).map((pt, i) => {
                const a = proj(ROAD[i][0], ROAD[i][1]), b = proj(pt[0], pt[1]);
                return <Line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4A5A6E" strokeWidth={4} strokeLinecap="round" />;
              })}
              {marks.map(l => {
                const p = proj(l.lat, l.lng);
                return (
                  <React.Fragment key={l.name}>
                    <Rect x={p.x - 3} y={p.y - 3} width={6} height={6} fill="#8FA3B8" />
                    <SvgText x={p.x + 6} y={p.y + 16} fill="#8FA3B8" fontSize={11}>{l.name}</SvgText>
                  </React.Fragment>
                );
              })}
              {sel && shown.includes(sel) ? (() => { const p = proj(sel.lat, sel.lng); return <Circle cx={p.x} cy={p.y} r={18} fill="none" stroke="#FFFFFF" strokeWidth={2} />; })() : null}
            </Svg>
            {placedPins.map(({ p, x, y, lx, ly }) => (
              <React.Fragment key={p.id}>
                <Pressable onPress={() => onPick(p.id)} accessibilityRole="button" accessibilityLabel={p.accessibilityLabel ?? `Map pin ${p.label}`} hitSlop={10}
                  style={{ position: 'absolute', left: x - 10, top: y - 10, width: 20, height: 20, borderRadius: 10, backgroundColor: p.colour, borderWidth: 2, borderColor: picked === p.id ? '#FFFFFF' : '#0E141B' }} />
                <Pressable onPress={() => onPick(p.id)} accessibilityElementsHidden importantForAccessibility="no"
                  style={{ position: 'absolute', left: lx, top: ly, backgroundColor: picked === p.id ? '#FFFFFF' : 'rgba(14,20,27,0.85)', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 }}>
                  <Text style={{ color: picked === p.id ? '#0E141B' : '#FFFFFF', fontSize: 11, fontWeight: '800' }}>{p.label}</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </>
        ) : null}
      </View>
      {outside.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <Text style={st.small}>{outsideLabel}</Text>
          {outside.map(p => (
            <Pressable key={p.id} onPress={() => onPick(p.id)} accessibilityRole="button" style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: C.panel2 }}>
              <Text style={{ color: C.text, fontWeight: '700' }}>{p.label} · {nearest(p.lat, p.lng)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  );
}
