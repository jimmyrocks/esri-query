import { EsriQueryObjectType } from '../helpers/esri-rest-types.js';
import { default as esriPbf } from './esri-pbf.js';
import fetch from 'node-fetch';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Converts numbers and booleans to strings, which is needed for the URLSearchParams
const toStringObj = (obj: { [key: string]: string | number | boolean }) =>
  Object.keys(obj)
    .map(key => ({ key, value: obj[key].toString() }))
    .reduce((a, c) => ({ ...a, ...{ [c.key]: c.value } }), {});

export default async function postAsync(url: string, query: EsriQueryObjectType): Promise<unknown> {
  const format = query.f;
  const body = new URLSearchParams(toStringObj(query));
  let result;
  try {
    result = await fetch(url, {
      // These properties are part of the Fetch Standard
      method: 'POST',
      headers: {
        'Accept': format === 'pbf' ? 'application/x-protobuf' : 'application/json'
      },            // Request headers. format is the identical to that accepted by the Headers constructor (see below)
      body: body,             // Request body. can be null, or a Node.js Readable stream
      redirect: 'follow',     // Set to `manual` to extract redirect headers, `error` to reject redirect
      signal: null,           // Pass an instance of AbortSignal to optionally abort requests
    });
    // Success!
    if (format === 'pbf') {
      const arrayBuffer = await result.arrayBuffer();

      // The buffer from fetch doesn't seem to work well with protobuf, this is a work-around
      // https://stackoverflow.com/questions/63428242/exception-illegal-buffer-thrown-in-protobufjs
      const cleanBuffer: Uint8Array = (Array.from(new Uint8Array(arrayBuffer)) as unknown) as Uint8Array;

      return await esriPbf(cleanBuffer, __dirname + '../../../EsriFeatureCollection.proto');
    } else {
      return await result.json();
    }
  } catch (e) {
    if (!(e instanceof Error)) {
      e = new Error(e);
    }
    e.status = (result && result.status) || 504; // make it a 504 if there is no status
    console.error('ERROR', result);
    throw (e);
  }
};
