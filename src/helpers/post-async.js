/* eslint-env node */
/* eslint-env es6 */
const superagent = require('superagent');
const esriPbf = require('./esri-pbf');

var postAsync = function (url, query) {
  return new Promise(function (resolve, reject) {
    let format = query.f;
    superagent.post(url)
      .set('Accept', format === 'pbf' ? 'application/x-protobuf'  : 'application/json')
      .send(superagent.serialize['application/x-www-form-urlencoded'](query))
      .end(function (err, res) {
        var body;
        if (format === 'pbf' && !err) {
          // TODO, it doesn't always support PBF even if it says it does, so expect that
          esriPbf(res.body, __dirname + '/esri_result.proto', 'esri_result.Result').then(r => resolve(r)).catch(e => reject(e));
        } else {
          try {
            body = JSON.parse(res.text);
          } catch (e) {
            e.text = res.text;
            err = err || e;
          }
          if (err) {
            reject(err);
          } else {
            resolve(body);
          }
        }
      });
  });
};

module.exports = postAsync;
