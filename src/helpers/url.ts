// ensure we always hit the ArcGIS /query endpoint (many servers reject POSTs to the layer root)
export function ensureQueryUrl(u: string | URL): string {
  const url = new URL(String(u));
  if (/\/query\/?$/i.test(url.pathname)) return url.toString();
  if (/\/(MapServer|FeatureServer)(?:\/\d+)?\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/?$/, '/query');
  }
  return url.toString();
}

