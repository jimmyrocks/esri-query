/* eslint-env node, es6 */
const {
  Readable
} = require('stream');

var stdout = function (options) {
  var writeStream;

  var open = function () {
    if (options.stream) {
      writeStream = new Readable();
      writeStream._read = function () {};
    }
  };
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
    'save': save
  };
};

module.exports = stdout;
