**esri-query** • [**Docs**](globals.md)

***

# esri-query

`esri-query` is a command-line tool that extracts data from ESRI REST endpoints when nothing else will.

## Table of Contents

-   [Installation](#installation)
-   [Usage](#usage)
-   [Options](#options)
-   [Testing](#testing)
-   [Formats](#formats)
    -   Input
        -   [ESRI Protobuf](#esri-protobuf-pbf)
        -   [ESRI JSON](#esri-json)
    -   Output
        -   [GeoJSON](#geojson)
        -   [GeoJSONSeq](#geojsonseq)
        -   [GeoPackage](#geopackage)

## Installation

To install `esri-query`, you need to have [Node.js](https://nodejs.org/en/download) installed.

You will then need to build it:

```bash
git clone https://github.com/jimmyrocks/esri-query.git
cd ./esri-query
npm run build
```

## Usage

To use `esri-query`, run the following command in your terminal:

```bash
esri-query --url <URL>
``` 

The `<URL>` should be the URL of the ESRI REST endpoint, for example `https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2`.

By default, the output is printed to the console in GeoJSON format. You can specify other options using flags, as shown in the [Options](#options) section.

## Options

| Flag | Description                                                                                         |
| ------------------------| --------------------------------------------------------------------------------------------------- |
| -h, --help               | Display this usage guide.                                                                           |
| -u, --url <url>          | The URL of the ESRI Rest Endpoint. MapServer or Feature Server (ex. https://.../FeatureServer/0)                                 |
| -w, --where string       | ESRI Style Where (Defaults to 1=1)                                                                  |
| -f, --format string      | [gpkg, geojson, geojsonseq]                                                                         |
| -o, --output string      | The file to write out (if set, type becomes file)                                                  |
| -y, --pretty             | Pretty Print JSON (geojsonseq will override this)                                              |
| -c, --feature-count num  | Features per query, reduce this number if you're seeing a lot of bad requests from the server (Default is server default)                                                     |
| -j, --json               | Use ESRI json to download data (otherwise it will try to use the [esri protobuf](https://github.com/Esri/arcgis-pbf/tree/main/proto/FeatureCollection) format)                  |
| -p, --progress           | Show progress during the process                                                                   |
| -l, --layer-name         | For GPKG files, specifies the layer-name, if unset, it will use the filename                        |
| -b, --no-bbox            | Does not calculate a bbox for each feature. (Bboxs are slower to generate, but may speed up calculations on the resulting file) |

### Examples

#### Simplest GeoJSON Example

```bash
npm run start -- --url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2"
``` 

#### to GeoJSONSeq File Example

GeoJSONSeq allows parallel processing in Tippecanoe

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--format geojsonseq \
--output ./example.geojsonseq
``` 

#### to GeoPackage File Example

GeoPackages load into PostgreSQL much faster than GeoJSON or GeoJSONSeq

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--format gpkg \
--output ./example.gpkg
```

## Testing

To test `esri-query`, run the following command in your terminal:

```bash
npm run test
```

## Formats

### Input

#### ESRI Protobuf (PBF)

No, this isn't the same as [MapBox Vector Tiles Protobuf schema](https://github.com/mapbox/vector-tile-spec), although both use the same underlying [Protobuf](https://developers.google.com/protocol-buffers) format.

ESRI Protobuf format provides "zig-zag encoded" points on a quantized grid that are stored in a binary format (Google Protobuf). (You can read all about [quantization parameters](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer-.htm#ESRI_SECTION2_2E4EB59F21E44D79AB2AEF9364005896)). The format is very similar to the ESRI JSON format, which is why this library uses the [Terraformer JS](https://github.com/terraformer-js/terraformer) library under the hood to convert the Protobuf data to GeoJSON.

This format is *much* faster than the ESRI JSON format, but is not compatible with all ArcGSI REST Servers/

#### ESRI JSON

ESRI has their own spatial format that provides some more information than standard GeoJSON. All ESRI ArcGIS REST Vector Endpoints support from form of ESRI JSON, so when PBF is not supported or a query is run with `--json`, this is the source format that is used. You can find more information about the ESRI JSON format in the [ArcGIS REST API Documentation](https://developers.arcgis.com/documentation/common-data-types/feature-object.htm).

### Output

#### GeoJSON

[GeoJSON](https://geojson.org/) is a standard GeoSpatial format that has the most interoperability. This is the "native" geospatial format used by esri-query, so all projection conversions are done on the server.

#### GeoJSONSeq

This is a format creates individual GeoJSON Features into a format that is more useful for parallel processing. The features are separated by a newline (LF), which makes it [Newline Delimited JSON](https://jsonlines.org/). It is useful for [Tippecanoe](https://github.com/mapbox/tippecanoe).

You can read more abot the format [on the ogr2ogr page](https://gdal.org/drivers/vector/geojsonseq.html). There is also [RS delimited version](https://datatracker.ietf.org/doc/html/rfc8142), but it's not supported by this tool since I don't have a use for it, but if you do, open an issue.

#### GeoPackage

[GeoPackages](https://www.geopackage.org/) are sqlite files that follow a standard for spatial data storage. In esri-query, these GeoPackage files are created with the [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) library, they do not use spatialite, and do not have a spatial index. GeoPackage uses the [Well-Known-Binary](https://en.wikipedia.org/wiki/Well-known_text_representation_of_geometry#Well-known_binary) format, so these files are very performant for importing to [PostGIS](https://postgis.net/) (which uses its own version of WKB).

Since the output GeoPackages aren't spatialite files or spatially indexed, they may be a little slower in tools like [QGIS](https://qgis.org/). You can use a tool like [ogr2ogr](https://gdal.org/programs/ogr2ogr.html) or [QGIS](https://qgis.org/) to convert this GeoPackage to one with a spatial index if needed.
