import { EsriFeatureLayerType } from "./esri-rest-types";

export default function (extent: EsriFeatureLayerType['extent']): EsriFeatureLayerType['extent'][] {
    // From: https://github.com/openaddresses/esri-dump/blob/master/lib/geometry.js
    const { xmax, xmin, ymax, ymin } = extent;
    var halfWidth = (xmax - xmin) / 2,
        halfHeight = (ymax - ymin) / 2;
    return [{
        ...extent,
        //xmin: xmin,
        //ymin: ymin,
        ymax: ymin + halfHeight,
        xmax: xmin + halfWidth
    },
    {
        ...extent,
        xmin: xmin + halfWidth,
        //ymin: ymin,
        ymax: ymin + halfHeight,
        //xmax: xmax
    },
    {
        ...extent,
        //xmin: xmin,
        ymin: ymin + halfHeight,
        xmax: xmin + halfWidth,
        //ymax: ymax
    },
    {
        ...extent,
        xmin: xmin + halfWidth,
        ymin: ymin + halfHeight,
        //xmax: xmax,
        //ymax: ymax
    }];
};