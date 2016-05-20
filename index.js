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
var nVertex = function (coord, param, isect, nxtIsect, edgeIn, edgeOut) { // (polygon- or intersection-) pseudo-vertex. There are two per self-intersection.
  this.coord = coord; // [x,y] of the vetrex of this pseudo-vertex - Vertex
  this.param = param; // fractional distance on its origin polygon edge
  this.isect = isect; // the corresponding intersection
  this.nxtIsect = nxtIsect; // the index in the intersection list of the next pseudo-vertex when following its origin polygon edge. This is 'index' in paper
  this.edgeIn = edgeIn; // index of incomming polygon edge
  this.edgeOut = edgeOut; // index of the the crossing polygon edge that created this pseudo-vertex. This is called 'l' in paper.
};
// NOTE: added incomming edge
// TODO: rename, and reorder? ("this is know al 'l' in paper")

var Intersection = function (coord, edge1, edge2, nVertex1, nVertex2, nxtIsect1, nxtIsect2, winding) { // pair of pseudo-vertices. There is one per self-intersection. The order of 1 and 2 is not important but should be invariant.
  this.coord = coord; // the vetrex of this pair of pseudo-vertex - Vertex
  this.edge1 = edge1; // index of origin polygon vertex of the first polygon edge creating this intersection // origin1
  this.edge2 = edge2; // index of origin polygon vertex of the second polygon edge creating this intersection // origin2
  this.nVertex1 = nVertex1;
  this.nVertex2 = nVertex2;
  this.nxtIsect1 = nxtIsect1; // index in the intersection list of the next intersection when comming from edge1 and following that polygon edge
  this.nxtIsect2 = nxtIsect2; // index in the intersection list of the next intersection when comming from edge2 and following that polygon edge
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
    	polygonEdgeArray.push([]);
      var currentIntersection = new Intersection(coord[i], i, undefined, undefined, undefined, undefined, -1, undefined); // index1 and winding are undefined yet, and edge2 is -1 for polygon-pseudo-vertex
      // TODO: use -1 or undefined? edge2 is also left undefined...
      intersectionList.push(currentIntersection);
    };
    // 2) Add self-intersection vertices to polygonEdgeArray (as nVertex) and (if unique) to intersectionList (as Intersection)
    for (var i = 0; i < isectsData.length; i++) {
    	var currentIsect = isectsData[i];
      var currentNVertex1 = new nVertex(currentIsect[0], currentIsect[8], undefined, undefined, currentIsect[1], currentIsect[4]);
      polygonEdgeArray[currentIsect[1]].push(currentNVertex1);
      if (currentIsect[7]){
        var currentIntersection = new Intersection(currentIsect[0], currentIsect[1], currentIsect[4], undefined, undefined, undefined, undefined, undefined); // index1 and winding are undefined yet, and edge2 is -1 for polygon-pseudo-vertex
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


    // NOTE: check if we can't just push all of them to the same array including polygon vertices, and then do one sort based on two keys. This can simplify much of the code later.
    // NOTE: check if loops over intersectionList can skip fist polygon edges
    // Fill indices in polygonEdgeArray
    for (var i = 0; i < polygonEdgeArray.length; i++){
      for (var j = 0; j < polygonEdgeArray[i].length; j++){
        if (j == polygonEdgeArray[i].length-1) {
          polygonEdgeArray[i][j].nxtIsect = (i + 1)%(polygonEdgeArray.length);
        } else {
          for (var k = 0; k < intersectionList.length; k++) { // TODO: faster using while loop
            if (intersectionList[k].coord.equals(polygonEdgeArray[i][j+1].coord)) {
              polygonEdgeArray[i][j].nxtIsect = k;
            };
          };
        };
      };
    };
    //console.log(JSON.stringify(polygonEdgeArray[8]));
    //console.log(JSON.stringify(polygonEdgeArray[9]));
    //console.log("---");
    //console.log(JSON.stringify(polygonEdgeArray));
    // NOTE: This could be done more efficiently. Join?, ...
    var startvertexindex = 0; // We will also use this loop to find starting vertex of outermost simple polygon
    for (var i = 0; i < coord.length-1; i++) {
      //console.log(i);
      if (coord[i][0] < coord[startvertexindex][0]) {
        startvertexindex = i;
      };
      if (polygonEdgeArray[i].length == 0) {
        intersectionList[i].nxtIsect1 = (i + 1)%(polygonEdgeArray.length);
      } else {
        for (var k = 0; k < intersectionList.length; k++) {
          if (intersectionList[k].coord.equals(polygonEdgeArray[i][0].coord)) { // faster using while
            intersectionList[i].nxtIsect1 = k;
          };
        };
      };
    };
    for (var i = coord.length-1; i < intersectionList.length; i++) {
      for (var j = 0; j < polygonEdgeArray.length; j++) {
        for (var k = 0; k < polygonEdgeArray[j].length; k++) {
          //console.log(JSON.stringify(intersectionList[i])+" and "+JSON.stringify(polygonEdgeArray[j][k]));
          if (intersectionList[i].coord.equals(polygonEdgeArray[j][k].coord)) { // This will happen twice
            polygonEdgeArray[j][k].isect = i; // TODO: define this earlier
            //console.log(JSON.stringify(intersectionList[i].edge1)+" and "+JSON.stringify(intersectionList[i].edge2)+" and "+JSON.stringify(polygonEdgeArray[j][k].edgeIn)+" and "+JSON.stringify(polygonEdgeArray[j][k].edgeOut));
            //console.log(polygonEdgeArray[j][k].nxtIsect);
            if (intersectionList[i].edge1 == polygonEdgeArray[j][k].edgeIn) {
              intersectionList[i].nxtIsect1 = polygonEdgeArray[j][k].nxtIsect;
              intersectionList[i].nVertex1 = [j,k]; // TODO: adapt to new polygonEdgeArray
            } else {
              intersectionList[i].nxtIsect2 = polygonEdgeArray[j][k].nxtIsect;
              intersectionList[i].nVertex2 = [j,k]; // TODO: adapt to new polygonEdgeArray
            };
          };
        };
      };
    };

    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));

    /*
    console.log(JSON.stringify(intersectionList[0]));
    console.log(JSON.stringify(intersectionList[11]));
    console.log(JSON.stringify(intersectionList[4]));
    console.log(JSON.stringify(intersectionList[12]));
    console.log(JSON.stringify(intersectionList[10]));
    console.log(JSON.stringify(intersectionList[13]));
    console.log(JSON.stringify(intersectionList[5]));
    console.log(JSON.stringify(intersectionList[14]));
    console.log(JSON.stringify(intersectionList[3]));
    console.log(JSON.stringify(intersectionList[17]));
    console.log(JSON.stringify(intersectionList[9]));
    */

    // Start at outer (convex) point and jump though intersectionList and make polygon by storing vertices.
    // When arriving at a pseudo-vertex that is not a polygon-pseudo-vertex, store it.
    // When done, take next nVertex from queue (check if ...)
    // It's 'index' will tell you where to jump next in the intersectionList if you want to make a polygon on the other side
    var intersectionQueue = []; // List of nVertex
    // while queue is not empty, take next one and check
    var outputpolygon = [intersectionList[startvertexindex].coord];
    var walker = {nxtIsect: intersectionList[startvertexindex].nxtIsect1, edge: startvertexindex};
    // TODO: verwarrende naam? index verwijst ook soms naar volgende => index1 > indexnext1?
    // TODO: check if this always gives right-handed => yes, because polygon edge
    while (startvertexindex != walker.nxtIsect){
      outputpolygon.push(intersectionList[walker.nxtIsect].coord);
      //console.log("walker: "+JSON.stringify(walker));
      //console.log(JSON.stringify(intersectionList[walker.nxtIsect]));
      if (intersectionList[walker.nxtIsect].nxtIsect2 == -1) {
        walker.edge = intersectionList[walker.nxtIsect].edge1;
        walker.nxtIsect = intersectionList[walker.nxtIsect].nxtIsect1;
      } else {
        if (walker.edge == intersectionList[walker.nxtIsect].edge1) {
          // add other to que
          // TODO: startwhile loop with pseudo-vector of first polygon, and therefor make these pseudo-vectors and add them all to one polygonEdgeArray
          intersectionQueue.push(intersectionList[walker.nxtIsect].nVertex2);
          // go to next
          walker.edge = intersectionList[walker.nxtIsect].edge2;
          walker.nxtIsect = intersectionList[walker.nxtIsect].nxtIsect2;
        } else {
          // add other to que
          intersectionQueue.push(intersectionList[walker.nxtIsect].nVertex1);
          // go to next
          walker.edge = intersectionList[walker.nxtIsect].edge1;
          walker.nxtIsect = intersectionList[walker.nxtIsect].nxtIsect1;
        };
      };
    };
    outputpolygon.push(intersectionList[walker.nxtIsect].coord); // close polygon
    console.log(JSON.stringify(outputpolygon));
    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));

    return [[outputpolygon]];
  };
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
