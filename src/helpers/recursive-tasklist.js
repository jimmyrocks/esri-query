/*eslint-env node*/
/*eslint-env es6*/

var runList = function (taskList) {
  return new Promise(function (resolve, reject) {
    var nextTask = taskList.shift();
    nextTask.task.apply(this, nextTask.params).then(function () {
      if (taskList.length) {
        resolve(runList(taskList));
      } else {
        resolve();
      }
    }).catch(function (e) {
      reject(e);
    });
  });
};

module.exports = runList;
