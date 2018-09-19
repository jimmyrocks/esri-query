/* eslint-env node */
/* eslint-env es6 */
const superagent = require('superagent');

var postAsync = function (url, query) {
  return new Promise(function (resolve, reject) {
    superagent.post(url)
      .set('Accept', 'application/json')
      .send(superagent.serialize['application/x-www-form-urlencoded'](query))
      .end(function (err, res) {
        var body;
        try {
          body = JSON.parse(res.text);
        } catch (e) {
          err = err || e;
        }
        if (err) {
          reject(err);
        } else {
          resolve(body);
        }
      });
  });
};

module.exports = postAsync;
