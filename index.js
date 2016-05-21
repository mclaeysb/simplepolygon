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
var nVertex = function (coord, param, isPolyPseudoVertex, edgeIn, edgeOut, isect, nxtIsectIn, otherNVertex, queueable) { // (polygon- or intersection-) pseudo-vertex. There are two per self-intersection.
  this.coord = coord; // [x,y] of the vetrex of this pseudo-vertex - Vertex
  this.param = param; // fractional distance on its origin polygon edge
  this.isPolyPseudoVertex = isPolyPseudoVertex; // NOTE: might not be used
  this.edgeIn = edgeIn; // index of incomming polygon edge
  this.edgeOut = edgeOut; // index of the the crossing polygon edge that created this pseudo-vertex. This is called 'l' in paper.
  this.isect = isect; // the corresponding intersection
  this.nxtIsectIn = nxtIsectIn; // the index in the intersection list of the next pseudo-vertex when following its incomming polygon edge. This is 'index' in paper
  this.otherNVertex = otherNVertex; // NOTE: keep?
  this.queueable = queueable;
};
// NOTE: added incomming edge
// TODO: rename, and reorder? ("this is know al 'l' in paper")
// TODO: implement that it knows isPolyPseudoVertex and otherNVertex

var Intersection = function (coord, isPolyPseudoVertex, edge1, edge2, nVertex1, nVertex2, nxtIsect1, nxtIsect2, winding, edge1WalkedAway, edge2WalkedAway) { // pair of pseudo-vertices. There is one per self-intersection. The order of 1 and 2 is not important but should be invariant.
  this.coord = coord; // the vetrex of this pair of pseudo-vertex - Vertex
  this.isPolyPseudoVertex = isPolyPseudoVertex;
  this.edge1 = edge1; // index of origin polygon vertex of the first polygon edge creating this intersection // origin1
  this.edge2 = edge2; // index of origin polygon vertex of the second polygon edge creating this intersection // origin2
  this.nVertex1 = nVertex1; // nVertex with edge1 as incomming edge // TODO: used?
  this.nVertex2 = nVertex2;
  this.nxtIsect1 = nxtIsect1; // index in the intersection list of the next intersection when comming from edge1 and following that polygon edge
  this.nxtIsect2 = nxtIsect2; // index in the intersection list of the next intersection when comming from edge2 and following that polygon edge
  this.winding = winding;
  this.edge1WalkedAway = edge1WalkedAway;
  this.edge2WalkedAway = edge2WalkedAway;
};
// NOTE: we use an index for origins


module.exports = function(feature) {

  // process input
  var geom = feature.geometry;
  if (geom.coordinates.length>1) throw new Error("A Polygon input without interior LinearRing's is required");
  var coord = geom.coordinates[0]; // From here on work with exterior LinearRing
  // TODO rename coord or .coord, such that polygon vertices list has other name then vertex property
  // TODO: adapt to take just array and not geojson as input. Also adapt output. Define if you want the polygon to be closed or not (see length-1)
  // TODO: Do we demand right-handed input? Is that possible for self-intersecions?

  // compute self-intersection points
  var isectsData = [];
  var isectsPoints = isects(coord, function filterFn(r, o, s0, e0, p, s1, e1, unique){
    // compute parameters t: how far are the self-intersections on both polygon edges o and p: ot and pt in [0,1]
    var ot = (r[0]-s0[0])/(e0[0]-s0[0]); // or equally: (r[1]-s0[1])/(e0[1]-s0[1])
    var pt = (r[0]-s1[0])/(e1[0]-s1[0]); // or equally: (r[1]-s1[1])/(e1[1]-s1[1]))
    isectsData.push([r, o, s0, e0, p, s1, e1, unique, ot, pt]);
  });

  // If no intersections are found, we can stop here
  if (isectsData.length == 0) return feature;
  else {

    // Build intersection master list and polygon edge array
    var polygonEdgeArray = []; // List of List of nVertex's encounted when following the polygon edges as they are given in input.
    // NOTE: we did not fill in polygon vertices
    var intersectionList = []; // List of Intersection's. Order does not matter, but should be invariant.
    var numPolyVertices = coord.length-1; // TODO: addapt to last vertex in or not
    var numIsect = isectsData.length;

    // Build polygonEdgeArray and intersectionList, without indices
    // 1) Add polygon vertices to polygonEdgeArray (as nVertex) and to intersectionList (as Intersection)
    for (var i = 0; i < numPolyVertices; i++) {
    	polygonEdgeArray.push([new nVertex(coord[i], 0, true, (i-1).mod(numPolyVertices), i, undefined, undefined, undefined, false)]);
      // index1 and winding are undefined yet, and edge2 is -1 for polygon-pseudo-vertex
      // TODO: use -1 or undefined? edge2 is also left undefined...
      intersectionList.push(new Intersection(coord[i], true, i, (i-1).mod(numPolyVertices), undefined, undefined, undefined, -1, undefined, false, true));
    };
    // 2) Add self-intersection vertices to polygonEdgeArray (as nVertex) and (if unique) to intersectionList (as Intersection)
    for (var i = 0; i < numIsect; i++) {
    	polygonEdgeArray[isectsData[i][1]].push(new nVertex(isectsData[i][0], isectsData[i][8], false, isectsData[i][1], isectsData[i][4], undefined, undefined, undefined, true));
      if (isectsData[i][7]){ // Only if unique
        // index1 and winding are undefined yet, and edge2 is -1 for polygon-pseudo-vertex
        intersectionList.push(new Intersection(isectsData[i][0], false, isectsData[i][1], isectsData[i][4], undefined, undefined, undefined, undefined, undefined, false, false));
      };
    };
    // Sort Arrays of polygonEdgeArray by param using compareFunction
    for (var i = 0; i < numPolyVertices; i++) {
      polygonEdgeArray[i].sort(function(a, b){
      if(a.param < b.param) return -1;
      if(a.param > b.param) return 1;
      return 0;
      });
    };
    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));


    // NOTE: check if we can't just push all of them to the same array including polygon vertices, and then do one sort based on two keys. This can simplify much of the code later.
    // Fill 'isect', 'nextIsect' in polygonEdgeArray
    for (var i = 0; i < numPolyVertices; i++){
      for (var j = 0; j < polygonEdgeArray[i].length; j++){
        var foundIsect = foundNextIsect = false;
        var k = 0;
        while (!(foundIsect && foundNextIsect) && (k < numIsect)) {
          // Check if you found isect
          if (intersectionList[k].coord.equals(polygonEdgeArray[i][j].coord)) {
            polygonEdgeArray[i][j].isect = k;
            foundIsect = true;
          };
          // Check if you found nextIsect (different if last one)
          if (j == polygonEdgeArray[i].length-1) {
            polygonEdgeArray[i][j].nxtIsectIn = (i + 1).mod(numPolyVertices);
            foundNextIsect = true;
          } else {
            if (intersectionList[k].coord.equals(polygonEdgeArray[i][j+1].coord)) {
              polygonEdgeArray[i][j].nxtIsectIn = k;
              foundNextIsect = true;
            }
          };
          k++
        };
      };
    };
    // NOTE: This could be done more efficiently. Join?, ...
    // Fill 'nVertex1', 'nVertex2', ‘nxtIsect1', 'nxtIsect2' in polygonEdgeArray
    for (var i = 0; i < numPolyVertices; i++) {
      intersectionList[i].nVertex1 = [i,0];
      if (polygonEdgeArray[i].length == 1) {
        intersectionList[i].nxtIsect1 = (i + 1).mod(numPolyVertices);
      } else {
        for (var k = 0; k < numIsect; k++) { // TODO: skip first in in this loop, or integrate
          if (intersectionList[k].coord.equals(polygonEdgeArray[i][1].coord)) { // TODO: faster using while
            intersectionList[i].nxtIsect1 = k;
          };
        };
      };
    };
    for (var i = numPolyVertices; i < numIsect; i++) {
      for (var j = 0; j < numPolyVertices; j++) {// TODO: faster using while
        for (var k = 0; k < polygonEdgeArray[j].length; k++) {
          //console.log(JSON.stringify(intersectionList[i])+" and "+JSON.stringify(polygonEdgeArray[j][k]));
          if (intersectionList[i].coord.equals(polygonEdgeArray[j][k].coord)) { // This will happen twice
            //console.log(JSON.stringify(intersectionList[i].edge1)+" and "+JSON.stringify(intersectionList[i].edge2)+" and "+JSON.stringify(polygonEdgeArray[j][k].edgeIn)+" and "+JSON.stringify(polygonEdgeArray[j][k].edgeOut));
            //console.log(polygonEdgeArray[j][k].nxtIsectIn);
            if (intersectionList[i].edge1 == polygonEdgeArray[j][k].edgeIn) {
              intersectionList[i].nxtIsect1 = polygonEdgeArray[j][k].nxtIsectIn;
              intersectionList[i].nVertex1 = [j,k]; // TODO: adapt to new polygonEdgeArray
            } else {
              intersectionList[i].nxtIsect2 = polygonEdgeArray[j][k].nxtIsectIn;
              intersectionList[i].nVertex2 = [j,k]; // TODO: adapt to new polygonEdgeArray
            };
          };
        };
      };
    };

    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));
    //console.log("--");

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

    // Find polygon vertex with lowest x-value as starting vertex of outermost simple polygon
    // For the outermost polygon, this is certainly a polygon vertex
    var outputPoly = [];
    var startPolyVertex = 0;
    for (var i = 0; i < numPolyVertices; i++) {
      if (coord[i][0] < coord[startPolyVertex][0]) {
        startPolyVertex = i;
      };
    };
    var isectQueue = [startPolyVertex]; // called intersectionQueue in article, but intersections don't know which one is next
    // while queue is not empty, take next one and check
    var i = 0;
    while (isectQueue.length>0) {
      console.log("### Now at polygon number "+i);
      var startIsect = isectQueue.shift(); // Take the first in line as the start pseudoVertex for this simple polygon
      console.log("starting at intersection number "+JSON.stringify(startIsect));
      outputPoly.push([]);
      outputPoly[i].push(intersectionList[startIsect].coord);
      var thisIsect = startIsect;
      if (intersectionList[startIsect].edge1WalkedAway) {
        var nxtIsect = intersectionList[startIsect].nxtIsect2;
        var walkingEdge = intersectionList[startIsect].edge2;
      } else {
        var nxtIsect = intersectionList[startIsect].nxtIsect1;
        var walkingEdge = intersectionList[startIsect].edge1;
      };
      //console.log(JSON.stringify(polygonEdgeArray));
      //console.log("---");
      //console.log(JSON.stringify(intersectionList));
      //console.log("---");
      while (!intersectionList[startIsect].coord.equals(intersectionList[nxtIsect].coord)){
        console.log("now at: "+thisIsect+" walking to "+nxtIsect+" over "+walkingEdge);
        console.log("with isectQueue: "+JSON.stringify(isectQueue));
        //console.log(JSON.stringify(intersectionList[nxtIsect]));
        outputPoly[i].push(intersectionList[nxtIsect].coord);
        console.log("pushed to polygon: "+nxtIsect);
        // Walk there
        // NOTE: make variable 'nxtIsectIn = intersectionList[nxtIsect]''?
        if (intersectionList[nxtIsect].nxtIsect2 == -1) { // TODO: do we have to treat this differently?
          // TODO: keep -1?
          walkingEdge = intersectionList[nxtIsect].edge1;
          thisIsect = nxtIsect;
          nxtIsect = intersectionList[nxtIsect].nxtIsect1;
        } else {
          if (isectQueue.indexOf(nxtIsect) >= 0) {
            console.log("index of: "+nxtIsect+" in queue is "+isectQueue.indexOf(nxtIsect));
            console.log("-> removing from queue: "+nxtIsect);
            isectQueue.splice(isectQueue.indexOf(nxtIsect),1);
          }
          //isectQueue.splice(isectQueue.indexOf(nxtIsect)); // If next intersection occures in list, remove it

          // check if you have to add it to the list
          if (walkingEdge == intersectionList[nxtIsect].edge1) {
            // add queue
            intersectionList[nxtIsect].edge2WalkedAway = true;
            console.log("check edge1WalkedAway "+JSON.stringify(intersectionList[nxtIsect]));
            if (intersectionList[nxtIsect].edge1WalkedAway == false) {
              console.log("-> pushing to queue: "+JSON.stringify(nxtIsect));
              isectQueue.push(nxtIsect);
            }
            // go to next
            walkingEdge = intersectionList[nxtIsect].edge2;
            thisIsect = nxtIsect;
            nxtIsect = intersectionList[nxtIsect].nxtIsect2;
          } else {
            // add queue
            intersectionList[nxtIsect].edge1WalkedAway = true;
            console.log("check edge2WalkedAway "+JSON.stringify(intersectionList[nxtIsect]));
            if (intersectionList[nxtIsect].edge2WalkedAway == false) {
              console.log("-> pushing to queue: "+JSON.stringify(nxtIsect));
              isectQueue.push(nxtIsect);
            };
            // go to next
            walkingEdge = intersectionList[nxtIsect].edge1;
            thisIsect = nxtIsect;
            nxtIsect = intersectionList[nxtIsect].nxtIsect1;
          };
        };
      };
      outputPoly[i].push(intersectionList[nxtIsect].coord); // close polygon
      i++
    }
    //console.log(JSON.stringify(polygonEdgeArray));
    //console.log(JSON.stringify(intersectionList));
    console.log("total amount of polygons: "+outputPoly.length);

    return outputPoly;
  };
};

// Function to compare Arrays of numbers. From http://stackoverflow.com/questions/7837456/how-to-compare-arrays-in-javascript
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

// Fix Javascript modulo for negative number. From http://stackoverflow.com/questions/4467539/javascript-modulo-not-behaving
Number.prototype.mod = function(n) {
    return ((this%n)+n)%n;
};
