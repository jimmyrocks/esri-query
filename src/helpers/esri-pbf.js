const protobuf = require('protobufjs');
const readFile = require('fs').readFile;
const promisify = require('util').promisify;
const readFilePromise = promisify(readFile);

const converters = {
  'esriFieldTypeOID': (v) => parseInt(v, 10),
  'esriFieldTypeString': (v) => v,
  'esriFieldTypeDouble': (v) => parseFloat(v, 10),
  'esriFieldTypeInteger': (v) => parseInt(v, 10),
  'default': (v) => v
};

const protoToJson = (message) => {
  let record = message.items[0].records[0]; // Are there ever multiple records or items? we should support it
  let esriJson = {};

  //Copy over most values
  Object.keys(record).forEach(key => {
    if (key !== 'geometryOffset') { //TODO ignore keys object?
      esriJson[key] = record[key];
    }
  });

  // Default to a point
  esriJson.geometryType = esriJson.geometryType || 'esriGeometryPoint';

  // let's clean up those features
  let attributes = esriJson.features.map(feature => feature.attributes.map((attribute, idx) => {
    let returnObj = {};
    let fieldName = esriJson.fields[idx].alias || esriJson.fields[idx].name; //TODO maybe the other order?
    Object.keys(attribute).forEach(key => {
      let converter = converters[key] ||  converters['default'];
      returnObj[fieldName] = converter(attribute[key]);
    });
    return returnObj;
  }).reduce((acc, val)=> {
    Object.keys(val).forEach(key => {
      acc[key] = val[key];
    });
    return acc;
  },{}));

  // Let's clean up the geometries
  let geometries = esriJson.features.map(feature => {
    let geometry = feature.geometry || {'verticies': [], 'paths': []};
    let counts = geometry.verticies.map(v => parseInt(v, 10));
    if (esriJson.geometryType === 'esriGeometryPoint') {
      counts = [1];
    };
    let x = geometry.paths.filter((_, idx) => idx % 2 === 0);
    let y = geometry.paths.filter((_, idx) => idx % 2 === 1);

    const deZigZag = (values, splits, multiplier, initialOffset,isY) => {
      let rings = splits.map((split, i) => {
        let lastValue = 0;
        return Array(split).fill().map((_, j) => {
          let valueOffset = splits.reduce((a,v,idx) => a += (idx < i ? v : 0), 0); 
          let value = parseInt(values[valueOffset +  j], 10);
          let sign = isY ? -1 : 1;
          let returnValue;
          if (j === 0) {
            returnValue = (value * sign) + (initialOffset / multiplier);
            //console.error('_', value, sign, initialOffset, multiplier, '=', returnValue * multiplier, ((value * -1 * sign)+ (initialOffset / multiplier)) * multiplier);
          } else {
            returnValue = (value * sign) + lastValue;
          }
          lastValue = returnValue; 
          return returnValue;
        }).map(v => v * multiplier);
      });
      return rings;
    };

    //console.log((record.geometryOffset));
    //console.error('offset', (record.geometryOffset));
    let ringsX = deZigZag(x, counts, parseFloat(record.geometryOffset.geometryOffsetMultiplier.multiplierX, 10), parseFloat(record.geometryOffset.geometryOffsetValue.offsetX,10));
    let ringsY = deZigZag(y, counts, parseFloat(record.geometryOffset.geometryOffsetMultiplier.multiplierY, 10), parseFloat(record.geometryOffset.geometryOffsetValue.offsetY,10), true);

    let rings = ringsX.map((ring, i) => ring.map((x, j) => [x, ringsY[i][j]]));

      return rings;
  });

  esriJson.features = attributes.map((attribute, idx) => {
    let polyGeom = {'rings': geometries[idx]};

    // points don't go in rings
    // TODO the enum should be working properly
    if (esriJson.geometryType === 'esriGeometryPoint') {
      polyGeom  = {'x': geometries[idx][0][0][0], 'y': geometries[idx][0][0][1]};
    } else if (esriJson.geometryType === 2) {
      polyGeom = {'paths': geometries[idx]};
    };

    return {'attributes': attribute, 'geometry': polyGeom};
  });

  return esriJson;
};

const toJson = async (fileBuffer, protoFile, mainResult) => {
  let loader = await protobuf.load(protoFile);
  let result = loader.lookup(mainResult);
  let message = result.decode(fileBuffer);
  return protoToJson(message);
};

const toBuffer = async (fileName) => {
  return await readFilePromise(fileName);
};

const main = (buffer, protoFile, mainResult) => new Promise((res, rej) => {
  mainResult = mainResult || 'esri_result.Result'; // TODO something?
  //toJson(buffer, protoFile, mainResult).then(esriJson => res(esriJson)).catch(e => rej(e));
  toJson(buffer, protoFile, mainResult).then(esriJson => res(esriJson)).catch(e => rej(e));
});

module.exports = main;

//main('/usr/src/app/test/counties_4326_multiring.pbf', '/usr/src/app/esri_result.proto', 'esri_result.Result');
//main('/usr/src/app/test/counties_3857_multiring.pbf', '/usr/src/app/esri_result.proto', 'esri_result.Result');
//main('/usr/src/app/test/nj_rail_ac_4326.pbf', '/usr/src/app/esri_result.proto', 'esri_result.Result');
//main('/usr/src/app/test/nj_rail_ac_3857.pbf', '/usr/src/app/esri_result.proto', 'esri_result.Result');
