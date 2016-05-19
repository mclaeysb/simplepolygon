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

// TODO: check default index.
// TODO: can we work with indeces for line segments?
// TODO: can constructors such as vertex disapear?
// NOTE: does the self-intersecting input polygon have a winding number? check paper + if not, add to input requirements in README
// TODO: add 'expose' to indicate main function. help function (including prototype) can come afterwards


// constructors
var Vertex = function (coord) {
  this.coord = coord; // [x,y]
};

var Polygon = function (vtxList) {
  this.vtxList = vtxList || []; // array of Vertex
};

/* // Not used since we simply use an index for the polygon edges, which is equal to origin/origin1
var LineSegment = function (start, end) { // polygon edge
  this.start = start; // start vertex - Vertex
  this.end = end; // end vertex - Vertex
};
*/

var MultiPolygon = function (polyList) {
  this.polyList = polyList || []; // Array of Polygon
};

var nVertex = function (v, param, index, l, incomming) { // (polygon- or intersection-) pseudo-vertex. There are two per self-intersection.
  this.v = v; // the vetrex of this pseudo-vertex - Vertex
  this.param = param; // fractional distance on its origin polygon edge
  this.index = index; // the index in the intersection list of the next pseudo-vertex when following its origin polygon edge
  this.l = l; // index of the the crossing polygon edge that created this pseudo-vertex
  this.incomming = incomming; // index of incomming polygon edge
};
// NOTE: added incomming edge
// TODO: rename, and reorder? ("this is know al 'l' in paper")

var Intersection = function (v, origin1, origin2, index1, index2, winding) { // pair of pseudo-vertices. There is one per self-intersection. The order of 1 and 2 is not important but should be invariant.
  this.v = v; // the vetrex of this pair of pseudo-vertex - Vertex
  this.origin1 = origin1; // index of origin polygon vertex of the first polygon edge creating this intersection
  this.origin2 = origin2; // index of origin polygon vertex of the second polygon edge creating this intersection
  this.index1 = index1; // index in the intersection list of the next intersection when comming from origin1 and following that polygon edge
  this.index2 = index2; // index in the intersection list of the next intersection when comming from origin2 and following that polygon edge
  this.winding = winding;
};
// NOTE: we use an index for origins


module.exports = function(feature) {

  // process input
  var geom = feature.geometry;
  if (geom.coordinates.length>1) throw new Error("A Polygon input without interior LinearRing's is required");
  var coord = geom.coordinates[0]; // From here on work with exterior LinearRing
  // TODO: adapt to take just array and not geojson as input. Also adapt output. Define if you want the polygon to be closed or not (see length-1)

  // compute self-intersection points
  var isectsData = [];
  var isectsPoints = isects(coord, function filterFn(r, o, s0, e0, p, s1, e1, unique){
    // compute parameters t: how far are the self-intersections on both polygon edges o and p: ot and pt in [0,1]
    var ot = (r[0]-s0[0])/(e0[0]-s0[0]); // or equally: (r[1]-s0[1])/(e0[1]-s0[1])
    var pt = (r[0]-s1[0])/(e1[0]-s1[0]); // or equally: (r[1]-s1[1])/(e1[1]-s1[1]))
    isectsData.push([r, o, s0, e0, p, s1, e1, unique, ot, pt]);
  });
//console.log(JSON.stringify(isectsData.length));

  // If no intersections are found, we can stop here
  if (isectsData.length == 0) return feature;
  else {

    // Build intersection master list and polygon edge array
    var polygonEdgeArray = []; // List of List of nVertex's encounted when following the polygon edges as they are given in input.
    // NOTE: we did not fill in polygon vertices
    var intersectionList = []; // List of Intersection's. Order does not matter, but should be invariant.

    // Build polygonEdgeArray and intersectionList, without indices
    // 1) Add polygon vertices to polygonEdgeArray (as nVertex) and to intersectionList (as Intersection)
    for (var i = 0; i < coord.length-1; i++) {
    	var currentVertex = new Vertex(coord[i]);
      polygonEdgeArray.push([]);
      var currentIntersection = new Intersection(currentVertex, i, undefined, undefined, -1, undefined); // index1 and winding are undefined yet, and origin2 is -1 for polygon-pseudo-vertex
      // TODO: use -1 or undefined? origin2 is also left undefined...
      intersectionList.push(currentIntersection);
    };
    // 2) Add self-intersection vertices to polygonEdgeArray (as nVertex) and (if unique) to intersectionList (as Intersection)
    for (var i = 0; i < isectsData.length; i++) {
    	var currentIsect = isectsData[i];
      var currentVertex = new Vertex(currentIsect[0]);
      var currentNVertex1 = new nVertex(currentVertex, currentIsect[8], undefined, currentIsect[4], currentIsect[1]);
      //var currentNVertex2 = new nVertex(currentVertex, currentIsect[9], undefined, currentIsect[1], currentIsect[4]);
      polygonEdgeArray[currentIsect[1]].push(currentNVertex1);
      //polygonEdgeArray[currentIsect[4]].push(currentNVertex2);
      if (currentIsect[7]){
        var currentIntersection = new Intersection(currentVertex, currentIsect[1], currentIsect[4], undefined, undefined, undefined); // index1 and winding are undefined yet, and origin2 is -1 for polygon-pseudo-vertex
        intersectionList.push(currentIntersection);
      };
    };
    // Sort Arrays of polygonEdgeArray by param using compareFunction
    for (var i = 0; i < polygonEdgeArray.length; i++) {
      polygonEdgeArray[i].sort(function(a, b){
      if(a.param < b.param) return -1;
      if(a.param > b.param) return 1;
      return 0;
      });
    };
    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));


    // NOTE: check if loops over intersectionList can skip fist polygon edges
    // Fill indices in polygonEdgeArray
    for (var i = 0; i < polygonEdgeArray.length; i++){
      for (var j = 0; j < polygonEdgeArray[i].length; j++){
        if (j == polygonEdgeArray[i].length-1) {
          polygonEdgeArray[i][j].index = i + 1; // NOTE: 9 will refer to 10, which may not be in coord
        } else {
          for (var k = 0; k < intersectionList.length; k++) {
            if (intersectionList[k].v.coord.equals(polygonEdgeArray[i][j].v.coord)) {
              polygonEdgeArray[i][j].index = k;
            };
          };
        };
      };
    };

    /*
    console.log(JSON.stringify(polygonEdgeArray[0]));
    console.log(JSON.stringify(polygonEdgeArray[3]));
    console.log("---");
    console.log(polygonEdgeArray[0][0]==polygonEdgeArray[0][1]);
    */

    //console.log(JSON.stringify(polygonEdgeArray));
    // NOTE: This could be done more efficiently. Join?, ...
    for (var i = 0; i < coord.length-1; i++) {
      //console.log(i);
      if (polygonEdgeArray[i].length == 0) {
        intersectionList[i].index1 = i + 1; // NOTE: 9 will refer to 10, which may not be in coord
      } else {
        //console.log(JSON.stringify(polygonEdgeArray[i][0]));
        intersectionList[i].index1 = polygonEdgeArray[i][0].index;
      }
    };
    for (var i = coord.length-1; i < intersectionList.length; i++) {
      for (var j = 0; j < polygonEdgeArray.length; j++) {
        for (var k = 0; k < polygonEdgeArray[j].length; k++) {
          //console.log(JSON.stringify(intersectionList[i])+" and "+JSON.stringify(polygonEdgeArray[j][k]));
          if (intersectionList[i].v.coord.equals(polygonEdgeArray[j][k].v.coord)) { // This will happen twice
            //console.log(JSON.stringify(intersectionList[i].origin1)+" and "+JSON.stringify(intersectionList[i].origin2)+" and "+JSON.stringify(polygonEdgeArray[j][k].incomming)+" and "+JSON.stringify(polygonEdgeArray[j][k].l));
            //console.log(polygonEdgeArray[j][k].index);
            if (intersectionList[i].origin1 == polygonEdgeArray[j][k].incomming) {
              intersectionList[i].index1 = polygonEdgeArray[j][k].index;
            } else {
              intersectionList[i].index2 = polygonEdgeArray[j][k].index;
            };
          };
        };
      };
    };

    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));

    // Start at outer (convex) point and jump though intersectionList and make polygon by storing vertices.
    // When arriving at a pseudo-vertex that is not a polygon-pseudo-vertex, store it.
    // When done, take next nVertex from queue (check if ...)
    // It's 'index' will tell you where to jump next in the intersectionList if you want to make a polygon on the other side
    var intersectionQueue = []; // List of nVertex




  //console.log(JSON.stringify(polygonEdgeArray));
  //console.log(JSON.stringify(intersectionList));

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

// Function to compare Arrays of numbers, from http://stackoverflow.com/questions/7837456/how-to-compare-arrays-in-javascript
// Warn if overriding existing method
if(Array.prototype.equals)
    console.warn("Overriding existing Array.prototype.equals. Possible causes: New API defines the method, there's a framework conflict or you've got double inclusions in your code.");
// attach the .equals method to Array's prototype to call it on any array
Array.prototype.equals = function (array) {
    // if the other array is a falsy value, return
    if (!array)
        return false;

    // compare lengths - can save a lot of time
    if (this.length != array.length)
        return false;

    for (var i = 0, l=this.length; i < l; i++) {
        // Check if we have nested arrays
        if (this[i] instanceof Array && array[i] instanceof Array) {
            // recurse into the nested arrays
            if (!this[i].equals(array[i]))
                return false;
        }
        else if (this[i] != array[i]) {
            // Warning - two different object instances will never be equal: {x:20} != {x:20}
            return false;
        }
    }
    return true;
}
// Hide method from for-in loops
Object.defineProperty(Array.prototype, "equals", {enumerable: false});
