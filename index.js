var fs = require('fs');
var isects = require('2d-polygon-self-intersections');
/* 	from https://www.npmjs.com/package/2d-polygon-self-intersections
	for n segments and k intersections,
	this is O(n^2)
	It can be optimised, but can be optimised to O((n + k) log n) through Bentley–Ottmann algorithm
	Which is an improvement for small k (k < o(n2 / log n))
  See possibly https://github.com/e-cloud/sweepline
	Future work this algorithm to allow interior LinearRing's and/or multipolygon input, since main.js should be enabled to handle multipolygon input.
*/

// constructors // TODO: check default index.

var Vertex = function (coord) {
  this.coord = coord; // [x,y]
};

var Polygon = function (vtxList) {
  this.vtxList = vtxList || []; // Array of Vertex
};

var LineSegment = function (start, end) {
  this.start = start; // Vertex
  this.end = end; // Vertex
};

var MultiPolygon = function (polyList) {
  this.polyList = polyList || []; // Array of Polygon
};

var nVertex = function (v, param, index, l) {
  this.v = v; // Vertex
  this.param = param;
  this.index = index;
  this.l = l; // LineSegment
};

var Intersection = function (v, origin1, origin2, index1, index2, winding) {
  this.v = v; // Vertex
  this.origin1 = origin1; // Vertex
  this.origin2 = origin2; // Vertex
  this.index1 = index1;
  this.index2 = index2;
  this.winding = winding;
};


module.exports = function(feature) {

  // process input
  var geom = feature.geometry;
  if (geom.coordinates.length>1) throw new Error("A Polygon input without interior LinearRing's is required");
  var coord = geom.coordinates[0]; // From here on work with exterior LinearRing

  // compute intersection points
  var isectsData = [];
  var isectsPoints = isects(coord, function filterFn(r, o, s0, e0, p, s1, e1, unique){
    if (unique) { // Note: this may cause problems when there are two self-intersections at the same point
          // compute parameters:
          var ot = (r[0]-s0[0])/(e0[0]-s0[0]); // or equally: (r[1]-s0[1])/(e0[1]-s0[1])
          var pt = (r[0]-s1[0])/(e1[0]-s1[0]); // or equally: (r[1]-s1[1])/(e1[1]-s1[1]))
          //var pt = ;
        isectsData.push([r, o, ot, s0, e0, p, pt, s1, e1]);
    }
  });
  console.log(JSON.stringify(isectsData));

  // If no intersections are found, we can stop here
  if (isectsPoints.length == 0) return feature;
  else {

    // Build intersection master list and polygon edge array
    var polygonEdgeArray = []; // List of nVertex's, each linking to a next nVertex
    var intersectionList = []; // List of Intersection's
    var lineSegmentList = []; // List of LineSegment's

    intersectionCounter = 0;
    for (var i = 0; i < coord.length-1; i++) {
  //    console.log(0,i);
  //  	console.log(JSON.stringify(coord[i]));
      var currentVertex = new Vertex(coord[i]);
      var currentIntersection = new Intersection(currentVertex, currentVertex); // rest is undefined at this point
      var currentLineSegment = new LineSegment(new Vertex(coord[i]), new Vertex(coord[i+1]));
      polygonEdgeArray.push(currentVertex, 0, -1, currentLineSegment); // TODO: may LineSegment just be the index?
      intersectionList.push(currentIntersection);
      lineSegmentList.push(currentLineSegment);
      intersectionCounter++;
    }

  //console.log(JSON.stringify(lineSegmentList));
  //console.log(JSON.stringify(polygonEdgeArray));

    return {
      type: 'Feature',
      geometry: {
        type: "MultiPolygon",
        coordinates: [[[[0,0],[1,0],[1,1],[0,0]]]]
        },
      properties: {
        winding: [1]
        }
    };
  }
};
