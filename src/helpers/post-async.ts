import { EsriQueryObjectType } from '../helpers/esri-rest-types.js';
import { default as esriPbf } from './esri-pbf.js';
import fetch from 'node-fetch';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Converts numbers and booleans to strings, which is needed for the URLSearchParams
 * 
 * @param obj The object to convert.
 * @returns A new object with all values converted to strings.
 */
const toStringObj = (obj: { [key: string]: string | number | boolean }) =>
  Object.keys(obj) // get all the keys of the object
    .map(key => ({ key, value: obj[key].toString() })) // map each key-value pair to an object with a string value
    .reduce((a, c) => ({ ...a, ...{ [c.key]: c.value } }), {}); // combine all the objects back into a single object

/**
 * Sends a POST request to the specified URL with the query object.
 * @param url The URL to which the POST request will be sent.
 * @param query The esri query object that will be sent in the request body.
 * @returns The response to the request, either as a JSON object or a protobuf message based on the format specified in the query param.
 */
export default async function postAsync(url: string | URL, query: EsriQueryObjectType): Promise<unknown> {
  // Extract the response format from the esri query object.
  const format = query.f;

  // Convert the query object to a URL-encoded string.
  const body = new URLSearchParams(toStringObj(query));
  let result;
  try {
    // Send a POST request to the URL with the esri query object in the request body.
    result = await fetch(url, {
      // These properties are part of the Fetch Standard
      method: 'POST', // We're going to always use POST because we can send more data than we can with GET
      headers: {
        'Accept': format === 'pbf' ? 'application/x-protobuf' : 'application/json'
        // Set the Accept header to the appropriate value based on the response format.
      },            // Request headers. format is the identical to that accepted by the Headers constructor (see below)
      body: body,             // Use our URL-encoded query object as the body
      redirect: 'follow',     // Can be set to `manual` to extract redirect headers, `error` to reject redirect
      signal: null,           // We can pass an instance of AbortSignal to optionally abort requests
    });
    // Success!
    // If the request was successful, return the response as either a JSON object or a protobuf message.
    if (format === 'pbf') {
      // If the response format is protobuf, convert the response buffer to a protobuf message.
      const arrayBuffer = await result.arrayBuffer();

      // The buffer from fetch doesn't seem to work well with protobuf, this is a work-around
      // https://stackoverflow.com/questions/63428242/exception-illegal-buffer-thrown-in-protobufjs
      const cleanBuffer: Uint8Array = (Array.from(new Uint8Array(arrayBuffer)) as unknown) as Uint8Array;

      return await esriPbf(cleanBuffer, __dirname + '../../../EsriFeatureCollection.proto');
    } else {
      // If the response format is JSON, parse the response as a JSON object.
      return await result.json();
    }
  } catch (e) {
    // If an error occurs, throw an error with the appropriate status code and log the error.
    if (!(e instanceof Error)) {
      e = new Error(e);
    }
    e.status = (result && result.status) || 504; // make it a 504 if there is no status
    console.error('ERROR', result);
    throw (e);
  }
};