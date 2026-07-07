[**esri-query**](../README.md)

***

[esri-query](../globals.md) / EsriQuery

# Class: EsriQuery

Defined in: [readers/esriQuery.ts:151](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L151)

## Constructors

### Constructor

> **new EsriQuery**(`options`): `EsriQuery`

Defined in: [readers/esriQuery.ts:197](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L197)

#### Parameters

##### options

[`EsriQueryOptions`](../type-aliases/EsriQueryOptions.md)

#### Returns

`EsriQuery`

## Properties

### extraHeaders?

> `optional` **extraHeaders?**: `Record`\<`string`, `string`\>

Defined in: [readers/esriQuery.ts:185](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L185)

***

### fields?

> `optional` **fields?**: `object`

Defined in: [readers/esriQuery.ts:155](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L155)

#### Index Signature

\[`key`: `string`\]: `object` & `object`

***

### options

> **options**: [`EsriQueryOptions`](../type-aliases/EsriQueryOptions.md)

Defined in: [readers/esriQuery.ts:162](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L162)

***

### queryUrl

> **queryUrl**: `string`

Defined in: [readers/esriQuery.ts:153](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L153)

***

### runtimeParams

> **runtimeParams**: `object`

Defined in: [readers/esriQuery.ts:166](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L166)

#### dedupeHashCount

> **dedupeHashCount**: `number`

#### featureCount

> **featureCount**: `number`

#### runTime

> **runTime**: `number`

***

### sourceInfo?

> `optional` **sourceInfo?**: `EsriFeatureLayerType`

Defined in: [readers/esriQuery.ts:163](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L163)

***

### supportsPagination?

> `optional` **supportsPagination?**: `boolean`

Defined in: [readers/esriQuery.ts:165](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L165)

***

### totalFeatureCount

> **totalFeatureCount**: `number`

Defined in: [readers/esriQuery.ts:164](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L164)

***

### url

> **url**: `string`

Defined in: [readers/esriQuery.ts:152](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L152)

***

### whereObj

> **whereObj**: `EsriQueryObjectType`

Defined in: [readers/esriQuery.ts:154](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L154)

***

### writer

> **writer**: `Writer`

Defined in: [readers/esriQuery.ts:179](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L179)

## Methods

### getProgressSnapshot()

> **getProgressSnapshot**(): `EsriQueryProgressSnapshot`

Defined in: [readers/esriQuery.ts:784](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L784)

#### Returns

`EsriQueryProgressSnapshot`

***

### getSourceInfo()

> **getSourceInfo**(): `Promise`\<`EsriFeatureLayerType`\>

Defined in: [readers/esriQuery.ts:816](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L816)

Gets the source info for an Esri feature or map service

#### Returns

`Promise`\<`EsriFeatureLayerType`\>

A promise containing the Esri Feature Layer

***

### requestGracefulStop()

> **requestGracefulStop**(`signal?`): `void`

Defined in: [readers/esriQuery.ts:804](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L804)

#### Parameters

##### signal?

`string`

#### Returns

`void`

***

### start()

> **start**(): `Promise`\<\{ `dedupeHashCount`: `number`; `featureCount`: `number`; `runTime`: `number`; \}\>

Defined in: [readers/esriQuery.ts:873](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L873)

Initiates the querying process for the given data source and writes the results to a file or stdout.

#### Returns

`Promise`\<\{ `dedupeHashCount`: `number`; `featureCount`: `number`; `runTime`: `number`; \}\>

Promise that resolves to an object containing runtime parameters after the querying process is complete.

#### Throws

Error if there is an issue reading source information.

***

### startQuery()

> **startQuery**(): `Promise`\<`void`\>

Defined in: [readers/esriQuery.ts:1149](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L1149)

#### Returns

`Promise`\<`void`\>

***

### write()

> **write**(`features`): `Promise`\<`number`\>

Defined in: [readers/esriQuery.ts:1065](https://github.com/jimmyrocks/esri-query/blob/d22c1c6959893f2760a46a92159e1d55a015fc18/src/readers/esriQuery.ts#L1065)

#### Parameters

##### features

`EsriFeatureType`[]

#### Returns

`Promise`\<`number`\>
