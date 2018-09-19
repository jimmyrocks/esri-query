var TaskQueue = function () {
  var tasks = 1;
  var res;
  var p = new Promise(function (resolve) {
    res = resolve;
  });
  return {
    add: function (r) {
      tasks += 1;
      if (tasks === 0) {
        res(r);
      }
      return tasks;
    },
    remove: function (r) {
      tasks += -1;
      if (tasks === 0) {
        res(r);
      }
      return tasks;
    },
    value: function () {
      return tasks;
    },
    promise: p
  };
};

module.exports = TaskQueue;
