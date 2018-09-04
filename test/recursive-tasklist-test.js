var runList = require('./recursive-tasklist');

var trials = 10;
var taskList = [];
var results = [];
var delayMax = 100;
var subTask;

var taskList;

subTask = function (v) {
  return new Promise(function (resolve, reject) {
    var delay = Math.floor(Math.random() * delayMax);
    // Add a random delay to simulate the real work a little
    console.log('running trial ' + v + ' with a ' + delay + 'ms delay');
    setTimeout(function () {
      if (v < trials) {
        taskList.push({
          'task': subTask,
          'params': [v + 1]
        });
        resolve({
          'delay': delay,
          'v': v,
          'last': false
        });
      } else {
        resolve({
          'delay': delay,
          'v': v,
          'last': true
        });
      }
    }, delay);
  });
};

taskList.push({
  'task': subTask,
  'params': [0]
});

runList(taskList, results).then(function (d) {
  console.log('data', d);
}).catch(function (e) {
  console.log('error', e);
});
