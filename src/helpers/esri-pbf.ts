import protobuf, { Long as LongType } from 'protobufjs';
import { default as Long } from 'long';
import { ArcGISFeatureType, ArcGISJsonRestType, FeatureCollectionType, GeometryTypeEnum } from './esri-pbf-types.js';

/**
 * Takes an array of LongType values, splits them up into arrays of length `splits`.
 * Returns an array of arrays of number values that have been transformed to undo zigzag encoding.
 * 
 * @param values An array of LongType values representing a polyline or polygon
 * @param splits An array of integers representing the number of values in each part of the polyline or polygon
 * @param scale The scale factor used to convert the LongType values to number values
 * @param initialOffset The initial offset used to convert the LongType values to number values
 * @param upperLeftOrigin A boolean indicating whether the origin is in the upper left (true) or lower left (false)
 * @returns An array of arrays of number values representing the unzizagged polyline or polygon
 */
const deZigZag = (values: Array<LongType>, splits: Array<number>, scale: number, initialOffset: number, upperLeftOrigin: boolean): number[][] =>
  // For each part of the polyline or polygon...
  splits.map((split, i) => {
    // Initialize the previous value to the initial offset
    let previousValue: Long = Long.fromNumber(initialOffset / scale);

    // For each value in the current part...
    return (new Array(split)).fill(undefined).map((_, j) => {
      // Clculate the offset for the current value
      const valueOffset = splits.reduce((a, v, idx) => a += (idx < i ? v : 0), 0); // Tally up all the offsets before this one

      // Get the current value and convert it to the Long type
      const value = values[valueOffset + j];
      const longValue = new Long(value.low, value.high, value.unsigned);

      // Calculate the sign based on the origin position (If it's upperLeft, we substract, otherwise we add)
      const sign = upperLeftOrigin ? -1 : 1;

      // Apply the zigzag decoding. Add or substract the long value from the previous value (depending on the origin position)
      const returnLong: Long = (longValue.multiply(sign)).add(previousValue);
      // Set the current value to the previous value
      previousValue = returnLong;

      // Convert the value to a number and scale it
      return returnLong.toNumber() * scale;
    })
  })

/**
* Converts a Long, number, or string value to a string.
* @param value - The value to convert.
* @returns The converted string value, or null if the input value is undefined.
*/
const longToString = (value: (Long | number | string)) => {
  if (value === undefined) {
    return null;
  } else if (typeof value === 'object') {
    return value.toString();
  } else {
    return value;
  }
};

/**
 * Convert a FeatureCollectionType PBF message to an ArcGISJsonRestType object
 * ArcGISJsonRestType Objects can then be converted with Terraformer
 *
 * @param message The FeatureCollectionType message to convert
 * @returns An ArcGISJsonRestType object
 */
const messageToJson = (message: FeatureCollectionType): ArcGISJsonRestType => {
  // If no query result, log error message and return empty features and fields
  if (message.queryResult === null) {
    console.error('No results in PBF');
    return {
      features: [],
      fields: [],
      exceededTransferLimit: false
    };
  }

  const { featureResult } = message.queryResult;
  const { transform, geometryType } = featureResult;
  const features = featureResult.features.map(feature => {

    // Parse the Attributes of the feature
    const attributes = feature.attributes
      .map((attribute, idx) => ({
        key: featureResult.fields[idx].name,
        value: attribute[Object.keys(attribute)[0]] // Get the attribute's value
      }))
      .reduce((a: Object, c: any) => {
        // Convert the value to a string and create a new object with the key and string value
        const newObj: any = {};
        newObj[c.key] = longToString(c.value);
        return { ...a, ...newObj };
      }, {});

    // Parse the geometries and clean up the quantization
    const counts = geometryType === GeometryTypeEnum.esriGeometryTypePoint ?
      [1] :
      feature.geometry.lengths as Array<number>;

    // Break the coords into X and Y rings
    const x: LongType[] = [];
    const y: LongType[] = [];
    (feature.geometry.coords).forEach((coord, idx) => {
      if (idx % 2 === 0) {
        x.push(new Long(coord.low, coord.high, coord.unsigned));
      } else {
        y.push(new Long(coord.low, coord.high, coord.unsigned));
      }
    });

    // dezigzag the rings and merge them
    const ringsX = deZigZag(x, counts, transform.scale.xScale, transform.translate.xTranslate, false);
    const ringsY = deZigZag(y, counts, transform.scale.yScale, transform.translate.yTranslate, transform.quantizeOriginPostion === 0);
    const rings = ringsX.map((ring, i) => ring.map((x, j) => [x, ringsY[i][j]]));

    // Return the geometry and attributes for the feature
    return {
      geometry: geometryType === 0 ?
        { x: rings[0][0][0], y: rings[0][0][1] } :
        (geometryType === GeometryTypeEnum.esriGeometryTypePolyline ?
          { 'paths': rings } :
          { 'rings': rings }
        ),
      attributes
    };
  }).filter(f => f !== undefined);

  // Create and return the result object
  return {
    features: features as Array<ArcGISFeatureType>,
    exceededTransferLimit: featureResult.exceededTransferLimit,
    objectIdFieldName: featureResult.objectIdFieldName,
    globalIdFieldName: featureResult.globalIdFieldName,
    geometryType: GeometryTypeEnum[featureResult.geometryType],
    spatialReference: { wkid: featureResult.spatialReference.wkid, latestWkid: featureResult.spatialReference.latestWkid },
    hasZ: featureResult.hasZ,
    hasM: featureResult.hasM,
    fields: featureResult.fields
  };
};

export default async function esriPbf(arrayBuffer: Uint8Array, protoFile: string) {
  const loader = await protobuf.load(protoFile);
  const messageLoader = loader.lookupType('esriPBuffer.FeatureCollectionPBuffer');

  const esriFeatureCollection = messageLoader.decode(arrayBuffer) as unknown as FeatureCollectionType;
  return messageToJson(esriFeatureCollection);
};

export { longToString, deZigZag, messageToJson }; // Export for testing
