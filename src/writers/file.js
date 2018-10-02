/* eslint-env node, es6 */

const fs = require('fs');

var fileWriter = function (options) {
  // write to file
  var fileId;
  var open = function () {
    fileId = fs.openSync(options.output, 'a');
    return fileId;
  };
  var close = function () {
    return fs.closeSync(fileId);
  };
  var write = function (line) {
    return fs.writeSync(fileId, line);
  };
  var save = function () {
    // We'll close the file and open it again as a way of "saving"
    fs.closeSync(fileId);
    return open();
  };

  return {
    'open': open,
    'close': close,
    'write': write,
    'save': save
  };
};

module.exports = fileWriter;
