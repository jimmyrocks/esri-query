import { Geometry } from 'arcgis-rest-api';
import { Long as LongType } from 'protobufjs';
// LongType is used for 64-bit integer values in protobuf fields

export type ArcGISFeatureType = {
    geometry: Geometry,
    attributes: { [key: string]: string | number | boolean }
};

export type ArcGISJsonRestType = {
    id?: number,
    objectIdFieldName?: string,
    globalIdFieldName?: string,
    geometryType?: string,
    spatialReference?: SpatialReferenceType
    hasZ?: boolean,
    hasM?: boolean,
    fields: Array<FieldType>,
    features: Array<ArcGISFeatureType>,
    exceededTransferLimit?: boolean
};

export type FieldType = {
    name: string,
    fieldType?: FieldTypeEnum,
    alias?: string,
    sqlType?: SQLTypeEnum,
    domain?: string,
    defaultValue?: string,
    length?: number
};

export type FeatureType = {
  attributes: ValueType[];                         // Value[] with optional index
  geometry?: GeometryTypePBF;                      // oneof compressed_geometry → geometry
  shapeBuffer?: EsriShapeBufferType;               // oneof compressed_geometry → shapeBuffer
  curveGeometry?: CurveGeometryType;               // oneof compressed_geometry → curveGeometry
  centroid?: GeometryTypePBF;
  aggregateGeometries?: GeometryTypePBF[];
  envelope?: EnvelopeType;
};

export type SpatialReferenceType = {
    wkid?: number,
    latestWkid?: number,
    vcsWkid?: number,
    latestVcsWkid?: number,
    wkt?: string
}

export type UniqueIdFieldType = {
    name: string,
    isSystemMaintained: boolean
}

export type GeometryPropertiesType = {
    shapeAreaFieldName: string,
    shapeLengthFieldName: string,
    units: string
}

export type ServerGensType = {
    minServerGen: number,
    serverGen: number
}

export enum GeometryTypeEnum {
    esriGeometryTypePoint = 0,
    esriGeometryTypeMultipoint = 1,
    esriGeometryTypePolyline = 2,
    esriGeometryTypePolygon = 3,
    esriGeometryTypeMultipatch = 4,
    esriGeometryTypeEnvelope = 5,
    esriGeometryTypeNone = 127
}

export enum FieldTypeEnum {
    esriFieldTypeSmallInteger = 0,
    esriFieldTypeInteger = 1,
    esriFieldTypeSingle = 2,
    esriFieldTypeDouble = 3,
    esriFieldTypeString = 4,
    esriFieldTypeDate = 5,
    esriFieldTypeOID = 6,
    esriFieldTypeGeometry = 7,
    esriFieldTypeBlob = 8,
    esriFieldTypeRaster = 9,
    esriFieldTypeGUID = 10,
    esriFieldTypeGlobalID = 11,
    esriFieldTypeXML = 12,
    esriFieldTypeBigInteger = 13,
    esriFieldTypeDateOnly = 14,
    esriFieldTypeTimeOnly = 15,
    esriFieldTypeTimestampOffset = 16
}

export enum SQLTypeEnum {
    sqlTypeBigInt = 0,
    sqlTypeBinary = 1,
    sqlTypeBit = 2,
    sqlTypeChar = 3,
    sqlTypeDate = 4,
    sqlTypeDecimal = 5,
    sqlTypeDouble = 6,
    sqlTypeFloat = 7,
    sqlTypeGeometry = 8,
    sqlTypeGUID = 9,
    sqlTypeInteger = 10,
    sqlTypeLongNVarchar = 11,
    sqlTypeLongVarbinary = 12,
    sqlTypeLongVarchar = 13,
    sqlTypeNChar = 14,
    sqlTypeNVarchar = 15,
    sqlTypeOther = 16,
    sqlTypeReal = 17,
    sqlTypeSmallInt = 18,
    sqlTypeSqlXml = 19,
    sqlTypeTime = 20,
    sqlTypeTimestamp = 21,
    sqlTypeTimestamp2 = 22,
    sqlTypeTinyInt = 23,
    sqlTypeVarbinary = 24,
    sqlTypeVarchar = 25,
    sqlTypeTimestampWithTimezone = 26
}

export enum QuantizeOriginPostionEnum {
    upperLeft = 0,
    lowerLeft = 1
}

// Low-level PBF types for geometry and attributes

export enum SegmentTypeEnum { line = 0, arc = 1, bezier = 2, ellipticArc = 3 }

export type EnvelopeType = {
  XMin: number;
  YMin: number;
  XMax: number;
  YMax: number;
  SpatialReference?: SpatialReferenceType;
};

export type GeometryTypePBF = {
  geometryType: GeometryTypeEnum;
  lengths?: number[];         // packed uint32
  coords?: LongType[];        // packed sint64 (delta-encoded)
  ids?: number[];             // packed sint32
};

export type SegmentSetType = {
  type: SegmentTypeEnum;      // segment kind
  count: number;              // number of segments
  parameters?: number[];      // per-segment params
};

export type CurveGeometryType = {
  geometryType: GeometryTypeEnum;
  parts?: number[];           // part lengths
  segmentSets?: SegmentSetType[];
  coords?: LongType[];        // packed sint64 (delta-encoded)
};

export type EsriShapeBufferType = { bytes: Uint8Array };

export type ValueType = {
  // exactly one (proto oneof); model as union-y bag in TS
  string_value?: string;
  float_value?: number;
  double_value?: number;
  sint_value?: number;
  uint_value?: number;
  int64_value?: LongType | string;   // may exceed 2^53-1
  uint64_value?: LongType | string;
  sint64_value?: LongType | string;
  bool_value?: boolean;
  null_value?: boolean;
  index?: number;                    // maps to field position
};

export type FeatureCollectionType = {
    queryResult: {
        featureResult: {
            fields: Array<FieldType>,
            geometryFields?: Array<{ field: FieldType; geometryType: GeometryTypeEnum }>,
            values: Array<any>,
            features: Array<FeatureType>,
            objectIdFieldName?: string,
            uniqueIdField?: UniqueIdFieldType,
            globalIdFieldName?: string,
            geohashFieldName?: string,
            geometryProperties?: GeometryPropertiesType,
            serverGens?: ServerGensType,
            geometryType?: GeometryTypeEnum,
            spatialReference?: SpatialReferenceType,
            exceededTransferLimit?: boolean,
            hasZ?: boolean,
            hasM?: boolean,

            transform?: {
                quantizeOriginPostion?: QuantizeOriginPostionEnum,
                scale: {
                    xScale: number,
                    yScale: number,
                    mScale: number,
                    zScale: number
                }
                translate: {
                    xTranslate: number,
                    yTranslate: number,
                    mTranslate: number,
                    zTranslate: number,
                }
            }
        }
    }
};