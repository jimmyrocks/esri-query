/* eslint-env node, es6 */
const Writers = {
  file: require('./writers/file.js'),
  postgres: require('./writers/postgres.js'),
  sqlite: require('./writers/sqlite.js'),
  stdout: require('./writers/stdout.js')
};

var GeoJsonWriter = function (options) {
  var header = '{"type": "FeatureCollection", "features": [';
  var footer = ']}';
  var bboxFooter = '], "bbox":{bbox}}';
  var delimiter = ',';

  // Set default options to stdout
  options = options || {};
  options.type = options.type || 'stdout';

  if (options['line-delimited'] || options.type === 'sqlite' || options.type === 'postgres') {
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
    save: function () {
      if (hasHeader && !hasFooter && !closed) {
        return writer.save();
      } else {
        throw new Error('Cannot save');
      }
    },
    stream: writer.stream,
    promise: writer.promise || {
      'then': function (callback) {
        return callback();
      }
    }
  };
};

module.exports = GeoJsonWriter;
