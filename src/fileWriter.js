/* eslint-env node, es6 */
const fs = require('fs');
const {
  Readable
} = require('stream');

var GeoJsonWriterSync = function (path, options) {
  var header = '{"type": "FeatureCollection", "features": [';
  var footer = ']}';
  var bboxFooter = '], "bbox":{bbox}}';
  var delimiter = ',';

  if (options.lineDelimited) {
    header = footer = bboxFooter = '';
    delimiter = '\n';
  };

  var open, write, close, fileId, first, closed, hasHeader, hasFooter, writeStream;

  if (options.stream) {
    writeStream = new Readable();
    writeStream._read = function () {};
  }

  if (path) {
    // write to file
    open = function (outFile) {
      var returnValue = fs.openSync(outFile, 'a');
      closed = false;
      first = true;
      hasHeader = false;
      hasFooter = false;
      return returnValue;
    };
    close = function () {
      closed = true;
      return fs.closeSync(fileId);
    };
    write = function (line) {
      return fs.writeSync(fileId, line);
    };
  } else {
    // stdout
    open = function () {
      hasHeader = false;
      hasFooter = false;
      closed = false;
      first = true;
    };
    close = function () {
      if (writeStream) {
        writeStream.push(null);
      }
      closed = true;
    };
    write = function (line) {
      if (writeStream) {
        writeStream.push(line);
      } else {
        process.stdout.write(line);
      }
    };
  }

  fileId = open(path);

  return {
    writeHeader: function () {
      if (first && !hasHeader && !closed) {
        hasHeader = true;
        return write(header);
      } else {
        throw new Error('Header already added');
      }
    },
    writeFooter: function (bbox) {
      var thisFooter = bbox ? bboxFooter.replace('{bbox}', JSON.stringify(bbox)) : footer;
      if (hasHeader && !hasFooter && !closed) {
        hasFooter = true;
        return write(thisFooter);
      } else {
        throw new Error(hasFooter ? 'Footer already added' : 'No header exists');
      }
    },
    writeLine: function (line) {
      var returnValue;
      if (hasHeader && !hasFooter && !closed) {
        returnValue = write((first ? '' : delimiter) + line);
        first = false;
        return returnValue;
      } else {
        throw new Error('Line cannot be written: hasHeader:' + hasHeader + ' hasFooter:' + hasFooter + ' closed:' + closed);
      }
    },
    close: function () {
      if (!closed) {
        return close();
      } else {
        throw new Error('Stream already closed');
      }
    },
    stream: writeStream || fileId
  };
};

module.exports = GeoJsonWriterSync;
