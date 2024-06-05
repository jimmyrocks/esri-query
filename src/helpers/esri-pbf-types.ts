import { Geometry } from 'arcgis-rest-api';
import { Long as LongType } from 'protobufjs';

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
    attributes: Array<{ [key: string]: any }>;
    centroid?: any;
    compressed_geometry: string;
    geometry: { lengths: number[], coords: LongType[] };
    length: number;
    shapeBuffer?: any;
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
    esriFieldTypeXML = 12
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
    sqlTypeVarchar = 25
}

export enum QuantizeOriginPostionEnum {
    upperLeft = 0,
    lowerLeft = 1
}

export type FeatureCollectionType = {
    queryResult: {
        featureResult: {
            fields: Array<FieldType>,
            values: Array<any>,
            features: Array<FeatureType>,
            objectIdFieldName?: string,
            globalIdFieldName?: string,
            geohashFieldName?: string,
            exceededTransferLimit?: boolean,
            hasZ?: boolean,
            hasM?: boolean,

            geometryType?: GeometryTypeEnum,
            uniqueIdField?: UniqueIdFieldType,
            geometryProperties?: GeometryPropertiesType,
            serverGens?: ServerGensType,
            spatialReference?: SpatialReferenceType,
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