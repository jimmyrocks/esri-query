/* eslint-env node, es6 */
const {
  Readable
} = require('stream');

var stdout = function (options) {
  var writeStream;
  if (options.stream) {
    writeStream = new Readable();
    writeStream._read = function () {};
  }

  var open = function () {};
  var save = function () {};
  var close = function () {
    if (writeStream) {
      writeStream.push(null);
    }
  };
  var write = function (line) {
    if (writeStream) {
      writeStream.push(line);
    } else {
      process.stdout.write(line);
    }
  };
  return {
    'open': open,
    'close': close,
    'write': write,
    'save': save,
    'stream': writeStream
  };
};

module.exports = stdout;
