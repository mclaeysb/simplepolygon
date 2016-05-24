var fs = require('fs');
var isects = require('2d-polygon-self-intersections');
/* 	from https://www.npmjs.com/package/2d-polygon-self-intersections
	For n segments and k intersections,	this is O(n^2)
	It can be optimised, but can be optimised to O((n + k) log n) through Bentley–Ottmann algorithm
	Which is an improvement for small k (k < o(n2 / log n))
  See possibly https://github.com/e-cloud/sweepline
	Future work this algorithm to allow interior LinearRing's and/or multipolygon input, since main.js should be enabled to handle multipolygon input.
*/

/*
  Some notes:
  - The edges are oriented from their first to their second polygon vertrex
  - At an intersection of two edges, two pseudo-vertices are present.
  - A pseudo-vertex has an incomming and outgoing (crossing) edge. The edges which roles in the other pseudo-vertex
  - At a polygon vertex, one pseudo-vertex is present.
  - We use the terms 'polygon edge', 'polygon vertex', 'self-intersection vertex', 'intersection' (which includes polygon-vertex-intersection and self-intersection) and 'pseudo-vertex' (which includes 'polygon-pseudo-vertex' and 'intersection-pseudo-vertex')
  - The following objects are stored and passed by the index in the list between brackets: Polygon vertices and edges (inputPoly), intersections (isectList) and pseudo-vertices (pseudoVtxListByEdge)
  - The algorithm is build to jump over intersections. It could also be built to jump over pseudo-vertices, but then each peuso-vertex should know what its companion pseudo-vertex is, and should know what the next pseudo-vertex along the outgoing edge is.
  - The above, however, explains why pseudo-vertices have the property 'nxtIsectAlongEdgeIn' (which is easy to find out and used later for nxtIsectAlongEdge1 and nxtIsectAlongEdge2) in stead of some propery 'nxtPseudoVtxAlongEdgeOut'
*/

/*
  This code differs from the algorithms and nomenclature of the article it is insired on in the following way:
  - No constructors are used, except 'PseudoVtx' and 'Isect'
  - 'LineSegments' of the polygon are called 'edges' here, and are represented, when necessary, by the index of their first point
  - 'edgeOut' is called 'l' in the article
  - 'PseudoVtx' is called 'nVtx'
  - 'Isect' is called 'intersection'
  - 'nxtIsectAlongEdgeIn' is called 'index'
  - 'edge1' and 'edge2' are named 'origin1' and 'origin2'
  - 'pseudoVtxListByEdge' is called 'polygonEdgeArray'
  - 'isectList' is called 'intersectionList'
*/

// Constructor for (polygon- or intersection-) pseudo-vertices. There are two per intersection.
var PseudoVtx = function (coord, param, edgeIn, edgeOut, isect, nxtIsectAlongEdgeIn) {
  this.coord = coord; // [x,y] of this pseudo-vertex
  this.param = param; // fractional distance of this intersection on incomming polygon edge
  this.edgeIn = edgeIn; // incomming polygon edge
  this.edgeOut = edgeOut; // outgoing polygon edge
  this.isect = isect; // the corresponding intersection
  this.nxtIsectAlongEdgeIn = nxtIsectAlongEdgeIn; // The next intersection when following the incomming polygon edge (so not when following edgeOut!)
}

// Constructor for a intersection. If the input polygon points are unique, there are two intersection-pseudo-vertices per self-intersection and one polygon-pseudo-vertex per polygon-vertex-intersection. Their labels 1 and 2 are not assigned a particular meaning but are permanent once given.
var Isect = function (coord, isPolyVtxIsect, edge1, edge2, nxtIsectAlongEdge1, nxtIsectAlongEdge2, walkedAwayOverEdge1, walkedAwayOverEdge2, winding) {
  this.coord = coord; // [x,y] of this intersection
  this.isPolyVtxIsect = isPolyVtxIsect; // is this a polygon-pseudo-vertex?
  this.edge1 = edge1; // first edge of this intersection
  this.edge2 = edge2; // second edge of this intersection
  this.nxtIsectAlongEdge1 = nxtIsectAlongEdge1; // the next intersection when following edge1
  this.nxtIsectAlongEdge2 = nxtIsectAlongEdge2; // the next intersection when following edge2
  this.walkedAwayOverEdge1 = walkedAwayOverEdge1; // Have we walked away from this intersection over edge1?
  this.walkedAwayOverEdge2 = walkedAwayOverEdge2; // Have we walked away from this intersection over edge2?
  this.winding = winding; // NOTE: used?
}


module.exports = function(feature) {

  // Process input
  if (feature.geometry.coordinates.length>1) throw new Error("The input polygon may not have interior rings");
  var inputPoly = feature.geometry.coordinates[0]; // From here on work with the exterior LinearRing
  if (!inputPoly[0].equals(inputPoly[inputPoly.length-1])) inputPoly.push(inputPoly[0]) // Close polygon if it is not
  if (!inputPoly.slice(0,inputPoly.length-1).isUnique()) throw new Error("The input polygon may not have non-unique vertices (except for the last one)");
  var numPolyVertices = inputPoly.length-1;

  // Compute self-intersections
  var isectsData = [];
  var isectsPoints = isects(inputPoly, function filterFn(r, o, s0, e0, p, s1, e1, unique){
    // Compute fractional distance of each self-intersection on both its polygon edges o and p: ot and pt in [0,1]
    var ot = (r[0]-s0[0])/(e0[0]-s0[0]); // or equally: (r[1]-s0[1])/(e0[1]-s0[1])
    var pt = (r[0]-s1[0])/(e1[0]-s1[0]); // or equally: (r[1]-s1[1])/(e1[1]-s1[1]))
    isectsData.push([r, o, s0, e0, p, s1, e1, unique, ot, pt]);
  });
  var numIsect = isectsData.length;

  // If no self-intersections are found, we can stop here
  if (numIsect == 0) return feature;

  // Build intersection master list and polygon edge array
  // TODO: ################# Change next comment + from here on
  var pseudoVtxListByEdge = []; // An Array with for each edge an Array containing the pseudo-vertices encounted when following the polygon edges as they are given in input.
  var isectList = []; // An Array containing intersections, as made by their constructor. First all polygon-vertex-intersections, then all self-intersections. The order of the latter is not important but is permanent once given.

  // Push polygon vertices to pseudoVtxListByEdge and isectList
  for (var i = 0; i < numPolyVertices; i++) {
  	pseudoVtxListByEdge.push([new PseudoVtx(inputPoly[i], 0, (i-1).mod(numPolyVertices), i, undefined, undefined)]);
    // TODO change this order
    isectList.push(new Isect(inputPoly[i], true, i, (i-1).mod(numPolyVertices), undefined, undefined, false, true, undefined));
  }
  // Push self-intersection vertices to pseudoVtxListByEdge and isectList
  // They are loaded by edgeIn
  for (var i = 0; i < numIsect; i++) {
  	pseudoVtxListByEdge[isectsData[i][1]].push(new PseudoVtx(isectsData[i][0], isectsData[i][8], isectsData[i][1], isectsData[i][4], undefined, undefined));
    if (isectsData[i][7]){ // Only if unique
      isectList.push(new Isect(isectsData[i][0], false, isectsData[i][1], isectsData[i][4], undefined, undefined, false, false, undefined));
    }
  }
  // Sort Arrays of pseudoVtxListByEdge by the fraction distance 'param' using compare function
  for (var i = 0; i < numPolyVertices; i++) {
    pseudoVtxListByEdge[i].sort(function(a, b){
    if(a.param < b.param) return -1;
    if(a.param > b.param) return 1;
    return 0;
    });
  }
  console.log(JSON.stringify(pseudoVtxListByEdge,null,2));

  // NOTE: check if we can't just push all of them to the same array including polygon vertices, and then do one sort based on two keys. This can simplify much of the code later.
  // Fill 'isect', 'nxtIsect' in pseudoVtxListByEdge
  for (var i = 0; i < numPolyVertices; i++){
    for (var j = 0; j < pseudoVtxListByEdge[i].length; j++){
      var foundIsect = foundNextIsect = false;
      var k = 0;
      while (!(foundIsect && foundNextIsect) && (k < numIsect)) {
        // Check if you found isect
        if (isectList[k].coord.equals(pseudoVtxListByEdge[i][j].coord)) {
          pseudoVtxListByEdge[i][j].isect = k;
          foundIsect = true;
        }
        // Check if you found nxtIsect (different if last one)
        if (j == pseudoVtxListByEdge[i].length-1) {
          pseudoVtxListByEdge[i][j].nxtIsectAlongEdgeIn = (i + 1).mod(numPolyVertices);
          foundNextIsect = true;
        } else {
          if (isectList[k].coord.equals(pseudoVtxListByEdge[i][j+1].coord)) {
            pseudoVtxListByEdge[i][j].nxtIsectAlongEdgeIn = k;
            foundNextIsect = true;
          }
        }
        k++
      }
    }
  }
  // NOTE: This could be done more efficiently. Join?, ...
  // Fill 'PseudoVtx1', 'PseudoVtx2', ‘nxtIsectAlongEdge1', 'nxtIsectAlongEdge2' in pseudoVtxListByEdge
  for (var i = 0; i < numPolyVertices; i++) {
    if (pseudoVtxListByEdge[i].length == 1) {
      isectList[i].nxtIsectAlongEdge1 = (i + 1).mod(numPolyVertices);
    } else {
      for (var k = 0; k < numIsect; k++) { // TODO: skip first in in this loop, or integrate
        if (isectList[k].coord.equals(pseudoVtxListByEdge[i][1].coord)) { // TODO: faster using while
          isectList[i].nxtIsectAlongEdge1 = k;
        }
      }
    }
  }
  for (var i = numPolyVertices; i < numIsect; i++) {
    for (var j = 0; j < numPolyVertices; j++) {// TODO: faster using while
      for (var k = 0; k < pseudoVtxListByEdge[j].length; k++) {
        //console.log(JSON.stringify(isectList[i])+" and "+JSON.stringify(pseudoVtxListByEdge[j][k]));
        if (isectList[i].coord.equals(pseudoVtxListByEdge[j][k].coord)) { // This will happen twice
          //console.log(JSON.stringify(isectList[i].edge1)+" and "+JSON.stringify(isectList[i].edge2)+" and "+JSON.stringify(pseudoVtxListByEdge[j][k].edgeIn)+" and "+JSON.stringify(pseudoVtxListByEdge[j][k].edgeOut));
          //console.log(pseudoVtxListByEdge[j][k].nxtIsectAlongEdgeIn);
          if (isectList[i].edge1 == pseudoVtxListByEdge[j][k].edgeIn) {
            isectList[i].nxtIsectAlongEdge1 = pseudoVtxListByEdge[j][k].nxtIsectAlongEdgeIn;
          } else {
            isectList[i].nxtIsectAlongEdge2 = pseudoVtxListByEdge[j][k].nxtIsectAlongEdgeIn;
          }
        }
      }
    }
  }

  //console.log(JSON.stringify(pseudoVtxListByEdge));
  //console.log(JSON.stringify(isectList));
  //console.log("--");

  /*
  console.log(JSON.stringify(isectList[0]));
  console.log(JSON.stringify(isectList[11]));
  console.log(JSON.stringify(isectList[4]));
  console.log(JSON.stringify(isectList[12]));
  console.log(JSON.stringify(isectList[10]));
  console.log(JSON.stringify(isectList[13]));
  console.log(JSON.stringify(isectList[5]));
  console.log(JSON.stringify(isectList[14]));
  console.log(JSON.stringify(isectList[3]));
  console.log(JSON.stringify(isectList[17]));
  console.log(JSON.stringify(isectList[9]));
  */

  // Start at outer (convex) point and jump though isectList and make polygon by storing vertices.
  // When arriving at a pseudo-vertex that is not a polygon-pseudo-vertex, store it.
  // When done, take next PseudoVtx from queue (check if ...)
  // It's 'index' will tell you where to jump next in the isectList if you want to make a polygon on the other side

  // Find polygon vertex with lowest x-value as starting vertex of outermost simple polygon
  // For the outermost polygon, this is certainly a polygon vertex
  var outputPoly = [];
  var startPolyVtx = 0;
  for (var i = 0; i < numPolyVertices; i++) {
    if (inputPoly[i][0] < inputPoly[startPolyVtx][0]) {
      startPolyVtx = i;
    }
  }
  var isectQueue = [startPolyVtx]; // called intersectionQueue in article, but intersections don't know which one is next
  // while queue is not empty, take next one and check
  var i = 0;
  while (isectQueue.length>0) {
    console.log("### Now at polygon number "+i);
    var startIsect = isectQueue.shift(); // Take the first in line as the start pseudoVtx for this simple polygon
    console.log("starting at intersection number "+JSON.stringify(startIsect));
    outputPoly.push([]);
    outputPoly[i].push(isectList[startIsect].coord);
    var thisIsect = startIsect;
    if (isectList[startIsect].walkedAwayOverEdge1) {
      var nxtIsect = isectList[startIsect].nxtIsectAlongEdge2;
      var walkingEdge = isectList[startIsect].edge2;
    } else {
      var nxtIsect = isectList[startIsect].nxtIsectAlongEdge1;
      var walkingEdge = isectList[startIsect].edge1;
    }
    //console.log(JSON.stringify(pseudoVtxListByEdge));
    //console.log("---");
    //console.log(JSON.stringify(isectList));
    //console.log("---");
    while (!isectList[startIsect].coord.equals(isectList[nxtIsect].coord)){
      console.log("now at: "+thisIsect+" walking to "+nxtIsect+" over "+walkingEdge);
      console.log("with isectQueue: "+JSON.stringify(isectQueue));
      //console.log(JSON.stringify(isectList[nxtIsect]));
      outputPoly[i].push(isectList[nxtIsect].coord);
      console.log("pushed to polygon: "+nxtIsect);
      // Walk there
      // NOTE: make variable 'nxtIsectAlongEdgeIn = isectList[nxtIsect]''?
      if (isectList[nxtIsect].isPolyVtxIsect) { // TODO: do we have to treat this differently?
        walkingEdge = isectList[nxtIsect].edge1;
        thisIsect = nxtIsect;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongEdge1;
      } else {
        if (isectQueue.indexOf(nxtIsect) >= 0) {
          console.log("index of: "+nxtIsect+" in queue is "+isectQueue.indexOf(nxtIsect));
          console.log("-> removing from queue: "+nxtIsect);
          isectQueue.splice(isectQueue.indexOf(nxtIsect),1);
        }
        //isectQueue.splice(isectQueue.indexOf(nxtIsect)); // If next intersection occures in list, remove it

        // check if you have to add it to the list
        if (walkingEdge == isectList[nxtIsect].edge1) {
          // add queue
          isectList[nxtIsect].walkedAwayOverEdge2 = true;
          console.log("check walkedAwayOverEdge1 "+JSON.stringify(isectList[nxtIsect]));
          if (isectList[nxtIsect].walkedAwayOverEdge1 == false) {
            console.log("-> pushing to queue: "+JSON.stringify(nxtIsect));
            isectQueue.push(nxtIsect);
          }
          // go to next
          walkingEdge = isectList[nxtIsect].edge2;
          thisIsect = nxtIsect;
          nxtIsect = isectList[nxtIsect].nxtIsectAlongEdge2;
        } else {
          // add queue
          isectList[nxtIsect].walkedAwayOverEdge1 = true;
          console.log("check walkedAwayOverEdge2 "+JSON.stringify(isectList[nxtIsect]));
          if (isectList[nxtIsect].walkedAwayOverEdge2 == false) {
            console.log("-> pushing to queue: "+JSON.stringify(nxtIsect));
            isectQueue.push(nxtIsect);
          }
          // go to next
          walkingEdge = isectList[nxtIsect].edge1;
          thisIsect = nxtIsect;
          nxtIsect = isectList[nxtIsect].nxtIsectAlongEdge1;
        }
      }
    }
    outputPoly[i].push(isectList[nxtIsect].coord); // close polygon
    i++
  }
  //console.log(JSON.stringify(pseudoVtxListByEdge));
  //console.log(JSON.stringify(isectList));
  console.log("total simple polygons: "+i);

  return {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [outputPoly]
            },
          properties: {
            winding: [1]
            }
        }
}

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
}

// Method to get array with only unique elements. From http://stackoverflow.com/questions/1960473/unique-values-in-an-array
Array.prototype.getUnique = function(){
   var u = {}, a = [];
   for(var i = 0, l = this.length; i < l; ++i){
      if(u.hasOwnProperty(this[i])) {
         continue;
      }
      a.push(this[i]);
      u[this[i]] = 1;
   }
   return a;
}

// Method to check if array is unique
Array.prototype.isUnique = function(){
   var u = {}, a = [];
   var isUnique = 1;
   for(var i = 0, l = this.length; i < l; ++i){
      if(u.hasOwnProperty(this[i])) {
        isUnique = 0;
        break;
      }
      u[this[i]] = 1;
   }
   return isUnique;
}
