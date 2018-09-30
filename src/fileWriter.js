/* eslint-env node, es6 */
const fs = require('fs');

var GeoJsonWriterSync = function (path) {
  var header = '{"type": "FeatureCollection", "features": [';
  var footer = ']}';
  var bboxFooter = '], "bbox":{bbox}}';

  var open, write, close, fileId, first, closed, hasHeader, hasFooter;
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
      closed = true;
    };
    write = function (line) {
      process.stdout.write(line);
    };
  }

  fileId = open(path);

  return {
    writeHeader: function () {
      if (first && !hasHeader && !closed) {
        hasHeader = true;
        write(header);
      } else {
        throw new Error('Header already added');
      }
    },
    writeFooter: function (bbox) {
      var thisFooter = bbox ? bboxFooter.replace('{bbox}', JSON.stringify(bbox)): footer;
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
        returnValue = write((first ? '' : ', ') + line);
        first = false;
        return returnValue;
      } else {
        throw new Error('Line cannot be written: hasHeader:'+hasHeader+' hasFooter:'+hasFooter+' closed:'+closed);
      }
    },
    close: function() {
      if (!closed) {
        return close();
      } else {
        throw new Error('Stream already closed');
      }
    }
  };
};

// var fileWriter = function (path, options) {
//   var cache = [];
//   var fd;
//
//   return {
//     'create': function (newOptions) {
//       options = newOptions || options || {};
//       return new Promise(function (resolve) {
//         fs.open(path, options.flags || 'a', (err, newFd) => {
//           if (err) throw err;
//           fd = newFd;
//           resolve(fd);
//         });
//       });
//     },
//     'append': function (data) {
//       return cache.push(data);
//     },
//     'save': function () {
//       return fs.appendFile(fd, cache.join('\n'), (err) => {
//         if (err) throw err;
//       });
//     },
//     'close': function () {
//       return fs.close(fd, (err) => {
//         if (err) throw err;
//       });
//     }
//   };
// };

module.exports = GeoJsonWriterSync;
