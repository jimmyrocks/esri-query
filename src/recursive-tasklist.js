var runList = function (taskList, data) {
  return new Promise(function (resolve, reject) {
    data = data || [];
    var nextTask = taskList.shift();
    nextTask.task.apply(this, nextTask.params).then(function (result) {
      data = data.concat(result);
      if (taskList.length) {
        resolve(runList(taskList, data));
      } else {
        resolve(data);
      }
    }).catch(function (e) {
      reject(e);
    });
  });
};

module.exports = runList;
