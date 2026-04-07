import protobuf from 'protobufjs';
import type { Long as LongType, Root } from 'protobufjs';
import Long from 'long';
import {
  ArcGISFeatureType,
  ArcGISJsonRestType,
  FeatureCollectionType,
  GeometryTypeEnum,
} from './esri-pbf-types.js';

// ------------------------------------------------------------
// Proto loader cache (avoid re-reading the .proto on each call)
// ------------------------------------------------------------
let protoLoader: Root | undefined;
const PBF_FORCE_GC_ENV = 'ESRIQ_PBF_FORCE_GC';

// Opt-in only: forcing GC on decode paths hurts throughput and adds pause jitter.
export function clearLargeObjects() {
  if (process.env[PBF_FORCE_GC_ENV] === '1' && (global as any).gc) {
    try { (global as any).gc(); } catch { }
  }
}

const ONEOF_KEY_RE = /_value$|Value$/;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

/** Convert protobufjs Long/objects/numbers to string/number, preserving big ints */
export function longToString(value: LongType | number | string | undefined): string | number | null {
  if (value == null) return null;
  return typeof value === 'object' ? (value as any).toString() : value;
}

/**
 * Decode delta-encoded, zig-zag quantized coordinates into double arrays.
 * Returns an array of parts (rings/paths/point lists), each a number[].
 */
export function deZigZag(
  values: Array<LongType>,
  splits: number[],
  scale: number,
  initialOffset: number,
  upperLeftOrigin: boolean
): number[][] {
  const sign = upperLeftOrigin ? -1 : 1;
  const scaledInitial = Long.fromNumber(initialOffset / scale);
  let idx = 0;
  const out: number[][] = [];

  for (let p = 0; p < splits.length; p++) {
    const len = splits[p] || 0;
    const part = new Array<number>(len);
    let prev = scaledInitial;
    for (let i = 0; i < len; i++) {
      const v = values[idx++];
      const L = Long.isLong(v) ? (v as Long) : new Long((v as any).low, (v as any).high, (v as any).unsigned);
      const decoded = L.mul(sign).add(prev);
      prev = decoded;
      part[i] = decoded.toNumber() * scale;
    }
    out.push(part);
  }
  return out;
}

// Map a feature's Value[] to attribute object using field name order and optional Value.index
function mapAttributes(fieldNames: string[], values: any[], palette?: any[]): Record<string, any> {
  const attrs: Record<string, any> = {};

  const pickOneof = (obj: any) => {
    if (!obj || typeof obj !== 'object') return undefined;
    // Support both snake_case (*_value) and camelCase (*Value) field names from protobufjs
    const keys = Object.keys(obj);
    const oneofKey = keys.find(x => ONEOF_KEY_RE.test(x));
    return oneofKey ? (obj as any)[oneofKey] : undefined;
  };

  // Resolve a dictionary-encoded value from a palette that can be flat, per-field, or nested under .values
  const resolveFromPalette = (fieldIdx: number, idx: number): any => {
    if (!Array.isArray(palette) || typeof idx !== 'number' || idx < 0) return undefined;
    const perField = (palette as any)[fieldIdx];
    if (Array.isArray(perField)) {
      const entry = perField[idx];
      const v = (entry && typeof entry === 'object' && Array.isArray((entry as any).values)) ? (entry as any).values[idx] : entry;
      const one = pickOneof(v);
      return (v && (v as any).null_value) ? null : one;
    }
    if (perField && typeof perField === 'object' && Array.isArray((perField as any).values)) {
      const v = (perField as any).values[idx];
      const one = pickOneof(v);
      return (v && (v as any).null_value) ? null : one;
    }
    // Fallback: flat palette
    const flat = (palette as any)[idx];
    const one = pickOneof(flat);
    return (flat && (flat as any).null_value) ? null : one;
  };

  const fieldCount = fieldNames.length;

  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? {};
    const rawIndex = typeof v.index === 'number' ? Math.trunc(v.index) : undefined;
    const hasFieldIndex = typeof rawIndex === 'number' && rawIndex >= 0 && fieldCount > 0;
    const inlineValue = pickOneof(v);
    const isNull = Boolean(v && (v.null_value || (v as any).nullValue));

    // Decide which field this value maps to. Respect Value.index when an inline
    // value or explicit null accompanies it (out-of-order fields), otherwise
    // fall back to positional order so dictionary palettes keep working.
    let fieldIdx = i;
    if (hasFieldIndex && (inlineValue !== undefined || isNull)) {
      fieldIdx = Math.min(fieldCount - 1, Math.max(0, rawIndex));
    } else if (fieldIdx >= fieldCount && fieldCount > 0) {
      fieldIdx = fieldCount - 1;
    }

    const key = fieldNames[fieldIdx] ?? String(fieldIdx);

    // Determine the value
    let val: any = undefined;
    if (isNull) {
      val = null;
    } else {
      val = inlineValue;
      // Dictionary encoding
      if (val === undefined && typeof rawIndex === 'number' && rawIndex >= 0) {
        const resolved = resolveFromPalette(fieldIdx, rawIndex);
        if (resolved !== undefined) val = resolved;
      }
    }

    attrs[key] = longToString(val);
  }
  return attrs;
}

// Build ArcGIS JSON geometry from decoded XY arrays
function buildGeometry(
  gtype: GeometryTypeEnum,
  ringsX: number[][],
  ringsY: number[][],
  envelope?: { XMin: number; YMin: number; XMax: number; YMax: number }
): any {
  switch (gtype) {
    case GeometryTypeEnum.esriGeometryTypePoint:
      return ringsX.length && ringsX[0].length ? { x: ringsX[0][0], y: ringsY[0][0] } : { x: NaN, y: NaN };
    case GeometryTypeEnum.esriGeometryTypeMultipoint:
      return { points: (ringsX[0] || []).map((x, i) => [x, (ringsY[0] || [])[i]]) };
    case GeometryTypeEnum.esriGeometryTypePolyline:
      return { paths: ringsX.map((xs, i) => xs.map((x, j) => [x, (ringsY[i] || [])[j]])) };
    case GeometryTypeEnum.esriGeometryTypePolygon:
      return { rings: ringsX.map((xs, i) => xs.map((x, j) => [x, (ringsY[i] || [])[j]])) };
    case GeometryTypeEnum.esriGeometryTypeEnvelope:
      if (envelope) {
        const { XMin, YMin, XMax, YMax } = envelope;
        return { rings: [[[XMin, YMin], [XMax, YMin], [XMax, YMax], [XMin, YMax], [XMin, YMin]]] };
      }
      return undefined;
    default:
      // Multipatch/None/unknown → return undefined; caller may skip or fallback
      return undefined;
  }
}

// Decode a single Feature into ArcGIS JSON geometry + attrs
function decodeFeatureToArcGIS(
  feature: any,
  geometryType: GeometryTypeEnum,
  transform: any
): ArcGISFeatureType | null {
  const fieldNames = (decodeFeatureToArcGIS as any)._fieldNames as string[];
  const palette = (decodeFeatureToArcGIS as any)._valuesPalette as any[];
  const rawValues = feature.attributes || [];
  const attrs = mapAttributes(fieldNames, rawValues, palette);

  // Optional debug dump for first feature when env DEBUG_ESRI_PBF is set
  try {
    if (process.env.DEBUG_ESRI_PBF && !(decodeFeatureToArcGIS as any)._debugLogged) {
      (decodeFeatureToArcGIS as any)._debugLogged = true;
      const shape = (arr: any): string => {
        if (!arr) return 'null';
        if (Array.isArray(arr)) return `Array(${arr.length})`;
        if (typeof arr === 'object') return `{${Object.keys(arr).slice(0, 5).join(',')}}`;
        return typeof arr;
      };
      // eslint-disable-next-line no-console
      console.error('[pbf] fields:', JSON.stringify(fieldNames));
      // eslint-disable-next-line no-console
      console.error('[pbf] values palette shape:', shape(palette));
      // eslint-disable-next-line no-console
      console.error('[pbf] first raw attributes entry:', JSON.stringify(rawValues?.[0] ?? null));
      // eslint-disable-next-line no-console
      console.error('[pbf] mapped attrs sample:', JSON.stringify(Object.fromEntries(Object.entries(attrs).slice(0, 8))));
    }
  } catch { }

  // Prefer compressed "geometry"; fall back to envelope if provided
  const geom = feature.geometry as any | undefined;
  const env = feature.envelope as any | undefined;

  // If curveGeometry is present, we don't tesselate here. Skip or fallback to envelope.
  if (!geom && feature.curveGeometry) {
    if (env) {
      const g = buildGeometry(GeometryTypeEnum.esriGeometryTypeEnvelope, [], [], env);
      return g ? { geometry: g, attributes: attrs } : { attributes: attrs } as any;
    }
    // No geometry we can handle → return attributes-only feature
    return { attributes: attrs } as any;
  }

  // No geometry? Try envelope; otherwise return attrs-only
  if (!geom) {
    if (env) {
      const g = buildGeometry(GeometryTypeEnum.esriGeometryTypeEnvelope, [], [], env);
      return g ? { geometry: g, attributes: attrs } : { attributes: attrs } as any;
    }
    return { attributes: attrs } as any;
  }

  // Split coords into X/Y streams (coords is [x0,y0,x1,y1,...] as sint64 longs)
  const coords: Array<LongType> = Array.isArray(geom.coords) ? geom.coords : [];
  const count = coords.length;
  const xs: Array<LongType> = new Array(Math.floor(count / 2));
  const ys: Array<LongType> = new Array(Math.floor(count / 2));
  for (let i = 0, j = 0; i < count; i += 2, j++) {
    xs[j] = coords[i];
    ys[j] = coords[i + 1];
  }

  const lengths: number[] = Array.isArray(geom.lengths) ? geom.lengths : [];
  const upperLeft = (transform?.quantizeOriginPostion ?? 0) === 0; // 0 = upperLeft

  // Point geometries can omit `lengths` per Esri's PBF spec.
  // In that case, treat the single coordinate pair as one part.
  const splits = lengths.length
    ? lengths
    : ((geometryType === GeometryTypeEnum.esriGeometryTypePoint || geometryType === GeometryTypeEnum.esriGeometryTypeMultipoint) && xs.length > 0 ? [xs.length] : lengths);

  const ringsX = deZigZag(xs, splits, transform?.scale?.xScale ?? 1, transform?.translate?.xTranslate ?? 0, false);
  const ringsY = deZigZag(ys, splits, transform?.scale?.yScale ?? 1, transform?.translate?.yTranslate ?? 0, upperLeft);

  const geometry = buildGeometry(geometryType, ringsX, ringsY, env);
  if (!geometry) return { attributes: attrs } as any;

  return { geometry, attributes: attrs };
}

// ------------------------------------------------------------
// Message → ArcGIS JSON translator (main logic)
// ------------------------------------------------------------
export function messageToJson(message: FeatureCollectionType): ArcGISJsonRestType {
  if (!message?.queryResult?.featureResult) {
    return { features: [], fields: [], exceededTransferLimit: false };
  }

  const header = message.queryResult.featureResult;
  const { transform, geometryType, fields } = header;
  const fieldNames = (fields || []).map(f => f.name);
  // Stash field names for mapAttributes in decodeFeatureToArcGIS
  (decodeFeatureToArcGIS as any)._fieldNames = fieldNames;
  // Stash shared values palette for dictionary-encoded attributes
  (decodeFeatureToArcGIS as any)._valuesPalette = header.values || [];

  const outFeatures: ArcGISFeatureType[] = [];
  for (const f of header.features || []) {
    const decoded = decodeFeatureToArcGIS(f, geometryType, transform);
    if (decoded) outFeatures.push(decoded);
  }

  const sr = header.spatialReference || (message as any).spatialReference || {};

  const result: ArcGISJsonRestType = {
    features: outFeatures,
    exceededTransferLimit: !!header.exceededTransferLimit,
    objectIdFieldName: header.objectIdFieldName,
    globalIdFieldName: header.globalIdFieldName,
    geometryType: GeometryTypeEnum[geometryType] as any,
    spatialReference: { wkid: (sr as any).wkid, latestWkid: (sr as any).latestWkid },
    hasZ: !!header.hasZ,
    hasM: !!header.hasM,
    fields: fields || [],
  };

  // Local references fall out of scope; rely on GC
  return result;
}

// ------------------------------------------------------------
// Public API: decode a PBF buffer into ArcGIS JSON
// ------------------------------------------------------------
export default async function esriPbf(arrayBuffer: Uint8Array, protoFile: string): Promise<ArcGISJsonRestType> {
  // Load and cache the .proto
  let loader: Root;
  if (protoLoader) loader = protoLoader; else protoLoader = loader = await protobuf.load(protoFile);

  const fcType = loader.lookupType('esriPBuffer.FeatureCollectionPBuffer');

  try {
    const fc = fcType.decode(arrayBuffer) as unknown as FeatureCollectionType;
    const json = messageToJson(fc);
    // Optional for low-memory/debug runs when started with --expose-gc.
    clearLargeObjects();
    return json;
  } catch (e) {
    console.error('Error decoding PBF message', e);
    throw e;
  }
}
