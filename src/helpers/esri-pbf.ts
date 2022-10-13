import protobuf, { Long as LongType } from 'protobufjs';
import { default as Long } from 'long';
import { ArcGISFeatureType, ArcGISJsonRestType, FeatureCollectionType, GeometryTypeEnum } from './esri-pbf-types.js';

const deZigZag = (values: Array<LongType>, splits: Array<number>, scale: number, initialOffset: number, lowerLeftOrigin: boolean): number[][] =>
  splits.map((split, i) => {
    let previousValue: Long = Long.fromNumber(initialOffset / scale); // Start at the offset initially
    return (new Array(split)).fill(undefined).map((_, j) => {
      const valueOffset = splits.reduce((a, v, idx) => a += (idx < i ? v : 0), 0); // Tally up all the offsets before this one
      const value = values[valueOffset + j];
      const longValue = new Long(value.low, value.high, value.unsigned);
      const sign = lowerLeftOrigin ? -1 : 1;

      const returnValue: Long = (longValue.multiply(sign)).add(previousValue);

      previousValue = returnValue;

      return returnValue;
    }).map(v => v.toNumber() * scale);
  })

const longToString = (value: (Long | number | string)) => {
  if (value === undefined) {
    return null;
  } else if (typeof value === 'object') {
    return value.toString();
  } else {
    return value;
  }
};

const messageToJson = (message: FeatureCollectionType): ArcGISJsonRestType => {
  if (message.queryResult === null) {
    console.error('No results in PBF');
    return {
      features: [],
      fields: [],
      exceededTransferLimit: false
    };
  }

  const featureResult = message.queryResult.featureResult;
  const fieldNames = featureResult.fields.map(field => field.name);
  const transform = featureResult.transform;
  const geometryType = featureResult.geometryType;
  const features = featureResult.features.map(feature => {

    // Parse the Attributes
    const attributes = feature.attributes
      .map((attribute, idx) => ({ key: fieldNames[idx], 'value': (attribute as any)[Object.keys(attribute)[0]] }))
      .reduce((a, c) => ({ ...a, ...{ [c.key]: longToString(c.value) } }), {});

    // Parse the geometries and clean up the quantization
    if (feature.geometry !== null) {
      const counts = geometryType === GeometryTypeEnum.esriGeometryTypePoint ?
        [1] :
        feature.geometry.lengths;

      // Break into X and Y rings
      const x = feature.geometry.coords.filter((_, idx) => idx % 2 === 0);
      const y = feature.geometry.coords.filter((_, idx) => idx % 2 === 1);

      // dezigzag the rings and merge + reproject then
      const ringsX = deZigZag(x, counts, transform.scale.xScale, transform.translate.xTranslate, false);
      const ringsY = deZigZag(y, counts, transform.scale.yScale, transform.translate.yTranslate, transform.quantizeOriginPostion === 0);
      const rings = ringsX.map((ring, i) => ring.map((x, j) => [x, ringsY[i][j]]));

      return {
        geometry: geometryType === 0 ?
          { x: rings[0][0][0], y: rings[0][0][1] } :
          (geometryType === GeometryTypeEnum.esriGeometryTypePolyline ?
            { 'paths': rings } :
            { 'rings': rings }
          ),
        attributes: attributes
      };
    } else {
      return undefined
    }
  }).filter(f => f !== undefined);
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
