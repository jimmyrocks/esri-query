
# esri-query

`esri-query` is a command-line tool that extracts data from ESRI REST endpoints when nothing else will.

## Table of Contents

-   [Installation](#installation)
-   [Usage](#usage)
-   [Options](#options)

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
| -y, --pretty             | Pretty Print JSON (line-delimited will override this)                                              |
| -f, --feature-count num  | Features per query (Default is server default)                                                     |
| -j, --json               | Use ESRI json to download data (otherwise it will try to use the esri PBF format)                  |
| -p, --progress           | Show progress during the process                                                                   |
| -l, --layer-name         | For GPKG files, specifies the layer-name, if unset, it will use the filename                        |
| -b, --no-bbox            | Does not calculate a bbox for each feature. (Bboxs are slower to generate, but may speed up calculations on the resulting file) |

### Examples

#### Simplest GeoJSON Example

```bash
npm run start -- --url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2"
``` 

#### to GeoJSONSeq File Example

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--format geojsonseq \
--output ./example.geojsonseq
``` 

#### to GeoPackage File Example

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--format gpkg \
--output ./example.gpkg
```
