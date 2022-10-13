# esri-query
Extracts data from ESRI REST endpoints when nothing else will

```
Options

  -h, --help                   Display this usage guide.
  -u, --url <url>              The URL of the ESRI Rest Endpoint. (ex. https://.../FeatureServer/0)
  -w, --where string           ESRI Style Where
  -f, --format string          [gpkg, geojson, geojsonseq]
  -o, --output string          The file to write out (if set, type becomes file)
  -y, --pretty                 Pretty Print JSON (line-delimited will override this)
  -f, --feature-count number   Features per query (Default is server default)
  -j, --json                   Use ESRI json to download data (otherwise it will try to use the esri PBF format)
  -p, --progress               Show progress during the process
  -l, --layer-name             For GPKG files, specifies the layer-name, if unset, it will use the filename
  -b, --no-bbox                Does not calculate a bbox for each feature. (Bboxs are slower to generate, but may speed up calculations on the resulting file)
```

usage:
`npm run start -- --url URL`

geojson example:
`npm run start -- "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2"`
