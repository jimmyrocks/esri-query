export type EsriQueryObjectType = {
    f: 'html' | 'json' | 'geojson' | 'pbf',
    resultOffset?: number,
    outFields?: string,
    orderByFields?: string
    returnGeometry?: boolean,
    resultRecordCount?: number,
    inSR?: string,
    outSR?: string,
    geometry?: string,
    geometryType?: 'esriGeometryPoint' | 'esriGeometryMultipoint' | 'esriGeometryPolyline' | 'esriGeometryPolygon' | 'esriGeometryEnvelope',
    spatialRel?: 'esriSpatialRelIntersects' | 'esriSpatialRelContains' | 'esriSpatialRelCrosses' | 'esriSpatialRelEnvelopeIntersects' | 'esriSpatialRelIndexIntersects' | 'esriSpatialRelOverlaps' | 'esriSpatialRelTouches' | 'esriSpatialRelWithin',
    where?: string,
    datumTransformation?: string,
    distance?: number,
    featureEncoding?: string,
    gdbVersion?: string,
    geometryPrecision?: string,
    groupByFieldsForStatistics?: string,
    havingClause?: string,
    historicMoment?: string,
    maxAllowableOffset?: string,
    multipatchOption?: 'xyFootprint' | 'stripMaterials' | 'embedMaterials' | 'externalizeTextures' | 'extent',
    objectIds?: string,
    outStatistics?: string,
    quantizationParameters?: string,
    relationParam?: string,
    resultType?: 'none' | 'standard' | 'tile',
    returnCentroid?: boolean,
    returnCountOnly?: boolean,
    returnDistinctValues?: boolean,
    returnExceededLimitFeatures?: boolean,
    returnExtentOnly?: boolean,
    returnIdsOnly?: boolean,
    returnM?: boolean,
    returnTrueCurves?: boolean,
    returnZ?: boolean,
    sqlFormat?: 'none' | 'standard' | 'native',
    time?: string,
    timeReferenceUnknownClient?: boolean,
    units?: 'esriSRUnit_Meter' | 'esriSRUnit_StatuteMile' | 'esriSRUnit_Foot' | 'esriSRUnit_Kilometer' | 'esriSRUnit_NauticalMile' | 'esriSRUnit_USNauticalMile'
};

// https://developers.arcgis.com/rest/services-reference/enterprise/layer-feature-service-.htm
export type EsriFeatureLayerType = {
    currentVersion: number,
    id: string,
    name: string,
    type: 'Feature Layer' | 'Table',
    parentLayer: string,
    displayField: string,
    description: string,
    copyrightText: string,
    subtypeField: string,
    defaultSubtypeCode: string,
    defaultVisibility: boolean,
    editFieldsInfo: {
        creationDateField: string,
        creatorField: string,
        editDateField: string,
        editorField: string,
        realm: string,
        //Added at 10.7
        dateFieldsTimeReference: {
            timeZone: string,
            respectsDaylightSaving: boolean
        }
    },
    //Added at 10.1
    ownershipBasedAccessControlForFeatures: {
        allowOthersToUpdate: boolean,
        allowOthersToDelete: boolean,
        allowOthersToQuery: boolean
    },
    //Added at 10.1
    syncCanReturnChanges: boolean,
    relationships: [
        {
            id: string,
            name: string,
            relatedTableId: string,
            cardinality: 'esriRelCardinalityOneToOne' | 'esriRelCardinalityOneToMany' | 'esriRelCardinalityManyToMany',//Added at 10.1
            role: 'esriRelRoleOrigin' | 'esriRelRoleDestination',//Added at 10.1
            keyField: string,//Added at 10.1
            composite: boolean,//Added at 10.1
            relationshipTableId: string,  //Added in 10.1. Returned only for attributed relationships
            keyFieldInRelationshipTable: string //Added in 10.1. Returned only for attributed relationships
        },
        {
            id: string,
            name: string,
            relatedTableId: string,
            cardinality: 'esriRelCardinalityOneToOne' | 'esriRelCardinalityOneToMany' | 'esriRelCardinalityManyToMany',//Added at 10.1
            role: 'esriRelRoleOrigin' | 'esriRelRoleDestination',//Added at 10.1
            keyField: string,//Added at 10.1
            composite: boolean,//Added at 10.1
            relationshipTableId: string,  //Added in 10.1. Returned only for attributed relationships
            keyFieldInRelationshipTable: string //Added in 10.1. Returned only for attributed relationships
        }
    ],
    isDataVersioned: boolean, //Added at 10.1
    isDataArchived: boolean, //Added at 10.6
    isDataBranchVersioned: boolean,  //Added at 10.7
    isDataReplicaTracked: boolean, //Added at 10.8.1
    isCoGoEnabled: boolean, //Added at 10.6
    supportsRollbackOnFailureParameter: boolean, //Added at 10.1
    dateFieldsTimeReference: {
        timeZone: string,
        respectsDaylightSaving: boolean
    },
    preferredTimeReference: { //Added at 10.9
        timeZone: string,
        respectsDaylightSaving: boolean
    },
    datesInUnknownTimezone: boolean //Added at 10.9
    archivingInfo: {
        supportsQueryWithHistoricMoment: boolean,
        startArchivingMoment: string
    }, //Added at 10.5
    supportsStatistics: boolean, //Added at 10.1
    supportsAdvancedQueries: boolean, //Added at 10.1
    supportsCoordinatesQuantization: boolean, //Added at 10.6.1
    supportsDatumTransformation: boolean, //Added at 10.8
    //properties applicable to feature layers only
    geometryType: 'esriGeometryPoint' | 'esriGeometryMultipoint' | 'esriGeometryPolyline' | 'esriGeometryPolygon' | 'esriGeometryEnvelope',
    //Added at 10.7
    geometryProperties: {
        shapeAreaFieldName: string,
        shapeLengthFieldName: string,
        units: string
    },
    minScale: string,
    maxScale: string,
    effectiveMinScale: string,
    effectiveMaxScale: string,
    supportsQuantizationEditMode: boolean,
    advancedQueryCapabilities: {
        supportsPagination: boolean,
        supportsTrueCurve: boolean,
        supportsQueryWithDistance: boolean,
        supportsLod: boolean,
        supportsReturningQueryExtent: boolean,
        supportsStatistics: boolean,
        supportsHavingClause: boolean, //Added at 10.6.1
        supportsOrderBy: boolean,
        supportsDistinct: boolean,
        supportsCountDistinct: boolean, //Added at 10.6.1
        supportsPaginationOnAggregatedQueries: boolean,
        supportsQueryWithResultType: boolean, //Added at 10.6.1
        supportsReturningGeometryCentroid: boolean, //Added at 10.6.1
        supportsSqlExpression: boolean,
        supportsOutFieldsSqlExpression: boolean,
        supportsTopFeaturesQuery: boolean,  //Added at 10.7
        supportsOrderByOnlyOnLayerFields: boolean,  //Added at 10.7,
        supportsQueryWithDatumTransformation: boolean, //Added at 10.8
        supportsPercentileStatistics: boolean, //Added at 10.8
        supportsQueryAttachments: boolean, //Added at 10.7.1
        supportsQueryAttachmentsWithReturnUrl: boolean, //Added at 10.7.1
        supportsQueryAnalytic: boolean //Added to online and hosted feature services at 10.9
        supportedMultipatchOptions: Array< //Added at 10.9
            'embedMaterials' |
            'xyFootprint' |
            'externalizeTextures' |
            'stripMaterials' |
            'extent'
        >
    },
    standardMaxRecordCountNoGeometry: number, //Added at 10.8
    supportsAsyncCalculate: boolean, //Added at 10.8
    supportsFieldDescriptionProperty: boolean,
    advancedEditingCapabilities: {
        supportedSqlFormatesInCalculate: Array<string>
    },
    advancedQueryAnalyticCapabilities: { //Added at online and hosted feature services at 10.9
        supportsPercentileAnalytic: boolean
    },
    userTypeExtensions: Array<string>,
    extent: {
        xmin: number, ymin: number, xmax: number, ymax: number,
        spatialReference: {
            wkid: string,
            latestWkid: string,
            //Added at 10.6 when map is published with a vertical coordinate system
            vcsWkid: string,
            latestVcsWkid: string,
            xyTolerance: string,
            zTolerance: string,
            mTolerance: string,
            falseX: string,
            falseY: string,
            xyUnits: string,
            falseZ: string,
            zUnits: string,
            falseM: string,
            mUnits: string,
        }
    },
    //Added at 10.6. Only returned when a map is published with a vertical coordinate system
    heightModelInfo: {
        heightModel: string,
        vertCRS: string,
        heightUnit: string
    },
    //Added at 10.6. Only returned when source data has a defined vertical coordinate system
    sourceHeightModelInfo: {
        heightModel: string,
        vertCRS: string,
        heightUnit: string
    }, //Added at 10.6 
    sourceSpatialReference: {
        wkid: string,
        latestWkid: string,
        //Added at 10.6. Returns when source data is published with a vertical coordinate system
        vcsWkid: string,
        latestVcsWkid: string,
        xyTolerance: number,
        zTolerance: number,
        mTolerance: number,
        falseX: number,
        falseY: number,
        xyUnits: number,
        falseZ: string,
        zUnits: number,
        falseM: number,
        mUnits: string
    },
    //for feature layers only
    drawingInfo: {
        renderer: string,
        transparency: string,
        labelingInfo: string
    },
    hasM: boolean, //if the features in the layer have M values, the hasM property will be true
    hasZ: boolean, //if the features in the layer have Z values, the hasZ property will be true
    //if the layer / table supports querying based on time
    enableZDefaults: boolean,//Added at 10.1
    zDefault: string,//Added at 10.1
    allowGeometryUpdates: boolean,//Added at 10.1
    timeInfo: {
        startTimeField: string,
        endTimeField: string,
        trackIdField: string,
        timeExtent: [number, number],
        timeReference: {
            timeZone: string,
            respectsDaylightSaving: boolean
        },
        timeInterval: number,
        timeIntervalUnits: string,
    },
    //if the layer / table has attachments, the hasAttachments property will be true
    hasAttachments: boolean,
    //from 10 onward - indicates whether the layer / table has htmlPopups
    htmlPopupType: 'esriServerHTMLPopupTypeNone | esriServerHTMLPopupTypeAsURL | esriServerHTMLPopupTypeAsHTMLText',
    //layer / table fields
    objectIdField: string,
    globalIdField: string,
    typeIdField: string,
    //from 10.0 fields of type (String, Date, GlobalID, GUID and XML) have an additional length property, editable properties
    //from 10.1 fields have an additional nullable property
    //from 10.6 fields have additional defaultValue and modelName properties. defaultValue can be a numeric or string value
    fields: Array<
        {
            name: string,
            type: 'esriFieldTypeInteger' |
            'esriFieldTypeSmallInteger' |
            'esriFieldTypeDouble' |
            'esriFieldTypeSingle' |
            'esriFieldTypeString' |
            'esriFieldTypeDate' |
            'esriFieldTypeGeometry' |
            'esriFieldTypeOID' |
            'esriFieldTypeBlob' |
            'esriFieldTypeGlobalID' |
            'esriFieldTypeRaster' |
            'esriFieldTypeGUID' |
            'esriFieldTypeXML',
            alias: string,
            domain: string,
            editable: boolean,
            nullable: boolean,
            length: number
            defaultValue: string | number,
            modelName: string,
        }
    >,
    //Added at 10.6.1
    geometryField: {
        name: string,
        type: 'esriGeometryPoint' | 'esriGeometryMultipoint' | 'esriGeometryPolyline' | 'esriGeometryPolygon' | 'esriGeometryEnvelope',
        alias: string,
        domain: string,
        editable: boolean,
        nullable: boolean,
        defaultValue: string,
        modelName: string
    },
    //layer / table sub-types
    types: Array<
        {
            id: string,
            name: string,
            domains: {
                [fieldName: string]: string
            },
            templates: Array<
                {
                    name: string,
                    description: string,
                    prototype: string,
                    drawingTool: 'esriFeatureEditToolNone' | 'esriFeatureEditToolPoint' | 'esriFeatureEditToolLine' | 'esriFeatureEditToolPolygon' |
                    'esriFeatureEditToolAutoCompletePolygon' | 'esriFeatureEditToolCircle' | 'esriFeatureEditToolEllipse' |
                    'esriFeatureEditToolRectangle' | 'esriFeatureEditToolFreehand'
                }
            >
        }
    >,
    //layer / table templates - usually present when the layer / table has no types
    templates: Array<
        {
            name: string,
            description: string,
            prototype: string,
            drawingTool: 'esriFeatureEditToolNone' | 'esriFeatureEditToolPoint' | 'esriFeatureEditToolLine' | 'esriFeatureEditToolPolygon' |
            'esriFeatureEditToolAutoCompletePolygon' | 'esriFeatureEditToolCircle' | 'esriFeatureEditToolEllipse' |
            'esriFeatureEditToolRectangle' | 'esriFeatureEditToolFreehand'
        }
    >,
    subtypes: Array<
        {
            code: string,
            name: string,
            defaultValues: {
                [fieldName: string]: string
            },
            domains: {
                [fieldName: string]: string
            }
        }
    >,
    //Maximum number of records returned in a query result
    maxRecordCount: number, //Added at 10.1
    standardMaxRecordCount: number, //Added at 10.6.1
    tileMaxRecordCount: number, //Added at 10.6.1
    maxRecordCountFactor: number, //Added at 10.6.1
    supportedQueryFormats: string, //Added at 10.1
    supportedExportFormats: string, //Added at 10.9.1
    supportedSpatialRelationships: Array<
        'esriSpatialRelIntersects' |
        'esriSpatialRelContains' |
        'esriSpatialRelCrosses' |
        'esriSpatialRelEnvelopeIntersects' |
        'esriSpatialRelIndexIntersects' |
        'esriSpatialRelOverlaps' |
        'esriSpatialRelTouches' |
        'esriSpatialRelWithin' |
        'esriSpatialRelRelation'
    > //Added at 10.9.1
    hasMetadata: boolean, //Added at 10.6.1
    hasStaticData: boolean,
    sqlParserVersion: string, //Added at 10.7
    isUpdatableView: boolean, //Added at 10.7
    //comma separated list of supported capabilities - e.g. Create,Delete,Query,Update,Editing
    capabilities: string
}