# esri-query: 

### version: 1.2.0
* Replace sqlite3 with better-sqlite3 and remove a lot of the unneeded async cpde
* Update packages
  * typedoc
  * ts-jest
  * @types/jest
  * protobuf
* Fix scoping issue with setTimeout in esriQuery that caused some skipped features to throw an error
* Fix issue with NULL geometries in GeoJSON (traverseCoords(geometry.coordinates)
* Fix issue with NULL geometries in GPKG (geom = wkx.Geometry.parseGeoJSON(feature.geometry)
