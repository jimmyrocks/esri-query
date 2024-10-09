# esri-query: 

### version 1.3.0
* Add geographic queries
* Allow Garbage Collector for very large queries
* Code cleanup
* Update packages
  * better-sqlite3             11.0.0  →   11.3.0    
  * command-line-args          ^5.2.1  →   ^6.0.0     
  * command-line-usage         ^7.0.1  →   ^7.0.3     
  * protobufjs                 ^7.3.0  →   ^7.4.0     
  * @types/better-sqlite3     ^7.6.10  →  ^7.6.11     
  * ts-jest                   ^29.1.4  →  ^29.2.5     
  * typedoc                  ^0.25.13  →  ^0.26.8   
  * typedoc-plugin-markdown    ^4.0.3  →   ^4.2.9
  * protobufjs                 ^7.3.2  →    ^7.4.0     
  * @types/jest              ^29.5.12  →  ^29.5.13     

### version 1.2.2
* Code cleanup
* Update packages
  * better-sqlite3              9.4.5  →    11.0.0
  * protobufjs                 ^7.2.6  →    ^7.3.0
  * @types/better-sqlite3      ^7.6.9  →   ^7.6.10
  * ts-jest                   ^29.1.2  →   ^29.1.4
  * typedoc                  ^0.25.12  →  ^0.25.13
  * typedoc-plugin-markdown   ^3.17.1  →    ^4.0.3

### version: 1.2.1
* include new documentation

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
