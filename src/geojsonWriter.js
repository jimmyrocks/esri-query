/* eslint-env node, es6 */
const Writers = {
  file: require('./writers/file.js'),
  stdout: require('./writers/stdout.js')
};

var GeoJsonWriter = function (options) {
  var header = '{"type": "FeatureCollection", "features": [';
  var footer = ']}';
  var bboxFooter = '], "bbox":{bbox}}';
  var delimiter = ',';

  if (options.lineDelimited) {
    header = footer = bboxFooter = '';
    delimiter = '\n';
  }

  var writer = new Writers[options.type](options);
  writer.open();
  
  var hasHeader = false;
  var hasFooter = false;
  var closed = false;
  var first = true;
  

  return {
    writeHeader: function () {
      if (first && !hasHeader && !closed) {
        hasHeader = true;
        return writer.write(header);
      } else {
        throw new Error('Header already added');
      }
    },
    writeFooter: function (bbox) {
      var thisFooter = bbox ? bboxFooter.replace('{bbox}', JSON.stringify(bbox)) : footer;
      if (hasHeader && !hasFooter && !closed) {
        hasFooter = true;
        return writer.write(thisFooter);
      } else {
        throw new Error(hasFooter ? 'Footer already added' : 'No header exists');
      }
    },
    writeLine: function (line) {
      var returnValue;
      if (hasHeader && !hasFooter && !closed) {
        returnValue = writer.write((first ? '' : delimiter) + line);
        first = false;
        return returnValue;
      } else {
        throw new Error('Line cannot be written: hasHeader:' + hasHeader + ' hasFooter:' + hasFooter + ' closed:' + closed);
      }
    },
    close: function () {
      if (!closed) {
        closed = true;
        return writer.close();
      } else {
        throw new Error(options.type + ' already closed');
      }
    },
    stream: writer.stream
  };
};

module.exports = GeoJsonWriter;
