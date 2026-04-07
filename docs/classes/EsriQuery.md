[**esri-query**](../README.md)

***

[esri-query](../globals.md) / EsriQuery

# Class: EsriQuery

Defined in: [readers/esriQuery.ts:38](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L38)

## Constructors

### Constructor

> **new EsriQuery**(`options`): `EsriQuery`

Defined in: [readers/esriQuery.ts:69](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L69)

#### Parameters

##### options

[`EsriQueryOptions`](../type-aliases/EsriQueryOptions.md)

#### Returns

`EsriQuery`

## Properties

### fields?

> `optional` **fields**: `object`

Defined in: [readers/esriQuery.ts:42](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L42)

#### Index Signature

\[`key`: `string`\]: `object` & `object`

***

### options

> **options**: [`EsriQueryOptions`](../type-aliases/EsriQueryOptions.md)

Defined in: [readers/esriQuery.ts:49](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L49)

***

### queryUrl

> **queryUrl**: `string`

Defined in: [readers/esriQuery.ts:40](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L40)

***

### runtimeParams

> **runtimeParams**: `object`

Defined in: [readers/esriQuery.ts:53](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L53)

#### featureCount

> **featureCount**: `number`

#### hashList

> **hashList**: `Record`\<`string`, `boolean`\>

#### runTime

> **runTime**: `number`

***

### sourceInfo?

> `optional` **sourceInfo**: `EsriFeatureLayerType`

Defined in: [readers/esriQuery.ts:50](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L50)

***

### supportsPagination?

> `optional` **supportsPagination**: `boolean`

Defined in: [readers/esriQuery.ts:52](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L52)

***

### totalFeatureCount

> **totalFeatureCount**: `number`

Defined in: [readers/esriQuery.ts:51](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L51)

***

### url

> **url**: `string`

Defined in: [readers/esriQuery.ts:39](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L39)

***

### whereObj

> **whereObj**: `EsriQueryObjectType`

Defined in: [readers/esriQuery.ts:41](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L41)

***

### writer

> **writer**: `Writer`

Defined in: [readers/esriQuery.ts:66](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L66)

## Methods

### getSourceInfo()

> **getSourceInfo**(): `Promise`\<`EsriFeatureLayerType`\>

Defined in: [readers/esriQuery.ts:100](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L100)

Gets the source info for an Esri feature or map service

#### Returns

`Promise`\<`EsriFeatureLayerType`\>

A promise containing the Esri Feature Layer

***

### start()

> **start**(): `Promise`\<\{ `featureCount`: `number`; `hashList`: `Record`\<`string`, `boolean`\>; `runTime`: `number`; \}\>

Defined in: [readers/esriQuery.ts:152](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L152)

Initiates the querying process for the given data source and writes the results to a file or stdout.

#### Returns

`Promise`\<\{ `featureCount`: `number`; `hashList`: `Record`\<`string`, `boolean`\>; `runTime`: `number`; \}\>

Promise that resolves to an object containing runtime parameters after the querying process is complete.

#### Throws

Error if there is an issue reading source information.

***

### startQuery()

> **startQuery**(): `Promise`\<`void`\>

Defined in: [readers/esriQuery.ts:340](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L340)

#### Returns

`Promise`\<`void`\>

***

### write()

> **write**(`features`): `Promise`\<`void`\>

Defined in: [readers/esriQuery.ts:268](https://github.com/jimmyrocks/esri-query/blob/c8094ccaf4b3dad4ae201d05ef2e068255440cb0/src/readers/esriQuery.ts#L268)

#### Parameters

##### features

`EsriFeatureType`[]

#### Returns

`Promise`\<`void`\>
