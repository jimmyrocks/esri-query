import protobuf from 'protobufjs';
import type { Long as LongType, Root } from 'protobufjs';
import Long from 'long';
import { ArcGISFeatureType, ArcGISJsonRestType, FeatureCollectionType, GeometryTypeEnum } from './esri-pbf-types.js';

// Cache for protobuf loaders
let protoLoader: Root | undefined = undefined;

// Function to clear large objects from memory
export function clearLargeObjects() {
  if (global.gc) {
    global.gc();
  } else {
    //console.warn('Garbage collection is not exposed. Run node with --expose-gc flag.');
  }
}

const deZigZag = (
  values: Array<LongType>,
  splits: Array<number>,
  scale: number,
  initialOffset: number,
  upperLeftOrigin: boolean
): number[][] => {
  const sign = upperLeftOrigin ? -1 : 1;
  const scaledInitialOffset = Long.fromNumber(initialOffset / scale);
  let valueIndex = 0;
  const result: number[][] = [];

  for (let i = 0; i < splits.length; i++) {
    const split = splits[i];
    const part: number[] = new Array(split);
    let previousValue = scaledInitialOffset;

    for (let j = 0; j < split; j++) {
      const value = values[valueIndex++];
      // Convert LongType to Long if necessary
      const longValue = Long.isLong(value) ? value : new Long(value.low, value.high, value.unsigned);
      const decodedValue = longValue.mul(sign).add(previousValue);
      previousValue = decodedValue;
      part[j] = decodedValue.toNumber() * scale;
    }

    result.push(part);
  }

  return result;
};

const longToString = (value: LongType | number | string | undefined): string | number | null => {
  if (value == null) return null;
  return (typeof value === 'object') ? value.toString() : value;
};

const messageToJson = (message: FeatureCollectionType): ArcGISJsonRestType => {
  if (!message.queryResult) {
    console.error('No results in PBF');
    return { features: [], fields: [], exceededTransferLimit: false };
  }

  let { featureResult } = message.queryResult;
  const { transform, geometryType, fields } = featureResult;
  const fieldNames = fields.map(field => field.name);

  const features: ArcGISFeatureType[] = [];
  for (const feature of featureResult.features) {
    const attributes: { [key: string]: any } = {};
    for (let i = 0; i < feature.attributes.length; i++) {
      const key = fieldNames[i];
      const value = feature.attributes[i][Object.keys(feature.attributes[i])[0]];
      attributes[key] = longToString(value);
    }

    if (feature.geometry?.coords) {
      const coordCount = feature.geometry.coords.length;
      const x = new Array(coordCount / 2);
      const y = new Array(coordCount / 2);

      for (let i = 0, j = 0; i < coordCount; i += 2, j++) {
        x[j] = feature.geometry.coords[i];
        y[j] = feature.geometry.coords[i + 1];
      }

      const counts = feature.geometry.lengths || [];
      const ringsX = deZigZag(x, counts, transform.scale.xScale, transform.translate.xTranslate, false);
      const ringsY = deZigZag(y, counts, transform.scale.yScale, transform.translate.yTranslate, transform.quantizeOriginPostion === 0);

      let geometry;
      switch (geometryType) {
        case GeometryTypeEnum.esriGeometryTypePoint:
          geometry = counts.length ? { x: ringsX[0][0], y: ringsY[0][0] } as any : { x: NaN, y: NaN };
          break;
        case GeometryTypeEnum.esriGeometryTypeMultipoint:
          geometry = { points: ringsX[0].map((x, i) => [x, ringsY[0][i]]) };
          break;
        case GeometryTypeEnum.esriGeometryTypePolyline:
          geometry = { paths: ringsX.map((ring, i) => ring.map((x, j) => [x, ringsY[i][j]])) };
          break;
        default: // Polygon
          geometry = { rings: ringsX.map((ring, i) => ring.map((x, j) => [x, ringsY[i][j]])) };
      }
      features.push({ geometry, attributes });
    }

    // Clear large objects periodically
    if (features.length % 1000 === 0) {
      clearLargeObjects();
    }
  }

  const asJson: ArcGISJsonRestType = {
    features,
    exceededTransferLimit: featureResult.exceededTransferLimit,
    objectIdFieldName: featureResult.objectIdFieldName,
    globalIdFieldName: featureResult.globalIdFieldName,
    geometryType: GeometryTypeEnum[featureResult.geometryType],
    spatialReference: { wkid: featureResult.spatialReference.wkid, latestWkid: featureResult.spatialReference.latestWkid },
    hasZ: featureResult.hasZ,
    hasM: featureResult.hasM,
    fields: featureResult.fields
  };

  // Clear message and featureResult from memory
  (message as any) = null;
  (featureResult as any) = null;

  return asJson;
};

export default async function esriPbf(arrayBuffer: Uint8Array, protoFile: string): Promise<ArcGISJsonRestType> {
  let loader: Root;
  if (protoLoader) {
    loader = protoLoader;
  } else {
    protoLoader = loader = await protobuf.load(protoFile);
  }
  const messageLoader = loader.lookupType('esriPBuffer.FeatureCollectionPBuffer');

  try {
    let esriFeatureCollection = messageLoader.decode(arrayBuffer) as unknown as FeatureCollectionType;
    const result = messageToJson(esriFeatureCollection);

    // Clear large objects after processing
    (esriFeatureCollection as any) = null;
    clearLargeObjects();

    return result;
  } catch (e) {
    console.error('Error decoding PBF message', e);
    throw e;
  }
}

export { longToString, deZigZag, messageToJson };