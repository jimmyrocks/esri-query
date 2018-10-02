var splitBbox = function (bbox) {
  // From: https://github.com/openaddresses/esri-dump/blob/master/lib/geometry.js
  var halfWidth = (bbox.xmax - bbox.xmin) / 2.0,
    halfHeight = (bbox.ymax - bbox.ymin) / 2.0;
  return [{
    xmin: bbox.xmin,
    ymin: bbox.ymin,
    ymax: bbox.ymin + halfHeight,
    xmax: bbox.xmin + halfWidth
  },
  {
    xmin: bbox.xmin + halfWidth,
    ymin: bbox.ymin,
    ymax: bbox.ymin + halfHeight,
    xmax: bbox.xmax
  },
  {
    xmin: bbox.xmin,
    ymin: bbox.ymin + halfHeight,
    xmax: bbox.xmin + halfWidth,
    ymax: bbox.ymax
  },
  {
    xmin: bbox.xmin + halfWidth,
    ymin: bbox.ymin + halfHeight,
    xmax: bbox.xmax,
    ymax: bbox.ymax
  }
  ];
};

module.exports = splitBbox;
