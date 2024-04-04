[esri-query](README.md) / Exports

# esri-query

## Table of contents

### Type Aliases

- [CliBaseOptionsType](modules.md#clibaseoptionstype)
- [CliGeoJsonOptionsType](modules.md#cligeojsonoptionstype)
- [CliOptionsType](modules.md#clioptionstype)
- [CliSqlOptionsType](modules.md#clisqloptionstype)

## Type Aliases

### CliBaseOptionsType

Ƭ **CliBaseOptionsType**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `feature-count` | `number` |
| `help` | `Boolean` |
| `json` | `boolean` |
| `method` | ``"geographic"`` \| ``"default"`` |
| `no-bbox` | `boolean` |
| `output` | `string` |
| `progress` | `boolean` |
| `url` | `string` |
| `where` | `string` |

#### Defined in

[index.ts:8](https://github.com/jimmyrocks/esri-query/blob/25abfd3/src/index.ts#L8)

___

### CliGeoJsonOptionsType

Ƭ **CliGeoJsonOptionsType**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `format` | ``"geojson"`` \| ``"geojsonseq"`` |
| `pretty` | `boolean` |

#### Defined in

[index.ts:20](https://github.com/jimmyrocks/esri-query/blob/25abfd3/src/index.ts#L20)

___

### CliOptionsType

Ƭ **CliOptionsType**: `Partial`\<[`CliBaseOptionsType`](modules.md#clibaseoptionstype) & [`CliGeoJsonOptionsType`](modules.md#cligeojsonoptionstype) \| [`CliSqlOptionsType`](modules.md#clisqloptionstype)\>

#### Defined in

[index.ts:31](https://github.com/jimmyrocks/esri-query/blob/25abfd3/src/index.ts#L31)

___

### CliSqlOptionsType

Ƭ **CliSqlOptionsType**: `Object`

#### Type declaration

| Name | Type |
| :------ | :------ |
| `format` | ``"gpkg"`` |
| `layer-name` | `string` |
| `output` | `string` |

#### Defined in

[index.ts:25](https://github.com/jimmyrocks/esri-query/blob/25abfd3/src/index.ts#L25)
