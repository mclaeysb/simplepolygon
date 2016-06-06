var isects = require('../geojson-polygon-self-intersections');
var helpers = require('turf-helpers');

/**
* Takes a complex (i.e. self-intersecting) polygon, and returns a MultiPolygon of the simple polygons it is composed of.
*
* @module simplepolygon
* @param {Feature} feature input polygon
* @return {MultiPolygon} feature containing component simple polygons, including properties such as their parent polygon, winding number and net winding number
*
* @example
* var poly = {
*   "type": "Feature",
*   "properties": {},
*   "geometry": {
*     "type": "Polygon",
*     "coordinates": [[[0,0],[2,0],[0,2],[2,2],[0,0]]]
*   }
* };
*
* var result = simplepolygon(poly);
*
* // =result
* // which will be
* // {
* //   "type": "Feature",
* //   "geometry": {
* //     "type": "MultiPolygon",
* //     "coordinates": [
* //       [[[0,0],[2,0],[1,1],[0,0]]],
* //       [[[1,1],[0,2],[2,2],[1,1]]]
* //     ]
* //   },
* //   "properties": {
* //     "parent": [-1,-1],
* //     "winding": [1,-1],
* //     "netWinding": [1,-1]
* //   }
* // }
*/

/*
  This algorithm works by walking from intersection to intersection over edges in their original direction, and making polygons by storing their vertices. Each intersection knows which is the next one given the edge we came over. When walking, we store where we have walked (since we must only walk over each (part of an) edge once), and keep track of intersections we encounter but have not walked away from in the other direction. We start at an outer polygon intersection to compute a first simple polygon. Once done, we use the queue to compute the polygon. By remembering how the polygons are nested and computing each polygons winding number, we can also compute the total winding numbers.

  Some notes:
  - The edges are oriented from their first to their second polygon vertrex
  - This algorithm employs the notion of 'pseudo-vertices' as outlined in the article
  - At an intersection of two edges, one or two pseudo-vertices are present
  - A pseudo-vertex has an incomming and outgoing (crossing) edge
  - At a polygon vertex, one pseudo-vertex is present, at a self-intersection two
  - We use the terms 'polygon edge', 'polygon vertex', 'self-intersection vertex', 'intersection' (which includes polygon-vertex-intersection and self-intersection) and 'pseudo-vertex' (which includes 'polygon-pseudo-vertex' and 'intersection-pseudo-vertex')
  - The following objects are stored and passed by the index in the list between brackets: Polygon vertices and edges (inputPoly), intersections (isectList) and pseudo-vertices (pseudoVtxListByRingAndEdge)
  - The above, however, explains why pseudo-vertices have the property 'nxtIsectAlongEdgeIn' (which is easy to find out and used later for nxtIsectAlongRingAndEdge1 and nxtIsectAlongRingAndEdge2) in stead of some propery 'nxtPseudoVtxAlongEdgeOut'
  - The algorithm checks of the input has no interior rings.
  - The algorithm checks of the input has no non-unique vertices. This is mainly to prevent self-intersecting input polygons such as [[0,0],[2,0],[1,1],[0,2],[1,3],[2,2],[1,1],[0,0]], whose self-intersections would not be detected. As such, many polygons which are non-simple, by the OGC definition, for other reasons then self-intersection, will not be allowed. An exception includes polygons with spikes or cuts such as [[0,0],[2,0],[1,1],[2,2],[0,2],[1,1],[0,0]], who are currently allowed and treated correctly, but make the output non-simple (by OGC definition). This could be prevented by checking for vertices on other edges.
  - The resulting component polygons are simple (in the sense that they do not contain self-intersections) and two component polygons are either disjoint or one fully encloses the other

  Currently, intersections are computed using the isects package, from https://www.npmjs.com/package/2d-polygon-self-intersections
	For n segments and k self-intersections, this is O(n^2)
  This is one of the most expensive parts of the algorithm
  It can be optimised to O((n + k) log n) through Bentley–Ottmann algorithm (which is an improvement for small k (k < o(n2 / log n)))
  See possibly https://github.com/e-cloud/sweepline
  Also, this step could be optimised using a spatial index
	Future work this algorithm to allow interior LinearRing's and/or multipolygon input, since main.js should be enabled to handle multipolygon input.
  The complexity of the simplepolygon-algorithm itself can be decomposed as follows:
  It includes a sorting step for the (s = n+2*k) pseudo-vertices (O(s*log(s))),
  And a lookup comparing (n+k) intersections and (n+2*k) pseudo-vertices, with worst-case complexity O((n+2*k)*(n+k))
  Additionally k is bounded by O(n^2)

  This code differs from the algorithms and nomenclature of the article it is insired on in the following way:
  - The code was written based on the article, and not ported from the enclosed C/C++ code
  - No constructors are used, except 'PseudoVtx' and 'Isect'
  - 'LineSegments' of the polygon are called 'edges' here, and are represented, when necessary, by the index of their first point
  - 'ringAndEdgeOut' is called 'l' in the article
  - 'PseudoVtx' is called 'nVtx'
  - 'Isect' is called 'intersection'
  - 'nxtIsectAlongEdgeIn' is called 'index'
  - 'ringAndEdge1' and 'ringAndEdge2' are named 'origin1' and 'origin2'
  - 'winding' is not implemented as a propoerty of an intersection, but as its own queue
  - 'pseudoVtxListByRingAndEdge' is called 'polygonEdgeArray'
  - 'pseudoVtxListByRingAndEdge' contains the polygon vertex at its end as the last item, and not the polygon vertex at its start as the first item
  - 'isectList' is called 'intersectionList'
  - 'isectQueue' is called 'intersectioQueue'
*/

// Constructor for (polygon- or intersection-) pseudo-vertices. There are two per intersection.
var PseudoVtx = function (coord, param, ringAndEdgeIn, ringAndEdgeOut, nxtIsectAlongEdgeIn) {
  this.coord = coord; // [x,y] of this pseudo-vertex
  this.param = param; // fractional distance of this intersection on incomming polygon edge
  this.ringAndEdgeIn = ringAndEdgeIn; // [ring index, edge index] of incomming polygon edge
  this.ringAndEdgeOut = ringAndEdgeOut; // [ring index, edge index] of outgoing polygon edge
  this.nxtIsectAlongEdgeIn = nxtIsectAlongEdgeIn; // The next intersection when following the incomming polygon edge (so not when following ringAndEdgeOut!)
}

// Constructor for a intersection. If the input polygon points are unique, there are two intersection-pseudo-vertices per self-intersection and one polygon-pseudo-vertex per polygon-vertex-intersection. Their labels 1 and 2 are not assigned a particular meaning but are permanent once given.
var Isect = function (coord, ringAndEdge1, ringAndEdge2, nxtIsectAlongRingAndEdge1, nxtIsectAlongRingAndEdge2, ringAndEdge1Walkable, ringAndEdge2Walkable) {
  this.coord = coord; // [x,y] of this intersection
  this.ringAndEdge1 = ringAndEdge1; // first edge of this intersection
  this.ringAndEdge2 = ringAndEdge2; // second edge of this intersection
  this.nxtIsectAlongRingAndEdge1 = nxtIsectAlongRingAndEdge1; // the next intersection when following ringAndEdge1
  this.nxtIsectAlongRingAndEdge2 = nxtIsectAlongRingAndEdge2; // the next intersection when following ringAndEdge2
  this.ringAndEdge1Walkable = ringAndEdge1Walkable; // May we (still) walk away from this intersection over ringAndEdge1?
  this.ringAndEdge2Walkable = ringAndEdge2Walkable; // May we (still) walk away from this intersection over ringAndEdge2?
}


module.exports = function(feature) {

  var debug = false;

  // Process input
  if (feature.geometry.type != "Polygon") throw new Error("The input feature must be a Polygon");
  // TODO:
  // if (feature.geometry.coordinates.length>1) throw new Error("The input polygon may not have interior rings");
  var numRings = feature.geometry.coordinates.length;
  var allVtx = [];
  for (var i = 0; i < numRings; i++) {
    var inputPoly = feature.geometry.coordinates[i];
    if (!inputPoly[0].equals(inputPoly[inputPoly.length-1])) {
      inputPoly.push(inputPoly[0]) // Close polygon if it is not
    }
    allVtx.push.apply(allVtx,inputPoly.slice(0,inputPoly.length-1));
  }
  if (!allVtx.isUnique()) throw new Error("The input polygon may not have duplicate vertices (except for the first and last vertex of each ring)");
  // TODO: used?
  var numPolyVertices = allVtx.length; // number of polygon vertices, with the last closing vertices not counted
  // TODO: replace by feature.geometry.coordinates[i]
  var inputPoly = feature.geometry.coordinates[0];
  // TODO: replace by feature.geometry.coordinates[i].length-1 or pseudoVtxListByRingAndEdge[i].length // or allVtx
  // var numPolyVertices = inputPoly.length-1;
  // TODO: replace numRings by pseudoVtxListByRingAndEdge.length
  // TODO: make variable 'poly' for feature.geometry.coordinates at the beginning, and find replace?
  // TODO: change name 'poly' to 'ring' everywhere, also in comments, and explains why not 'polygons'

  // TODO: reorder selfIsectsData. Also reorder isect: walkable after edge
  // Compute self-intersections
  var fpp = 10; // floating point precision
  var selfIsectsData = isects(feature, fpp, function filterFn(isect, ring0, edge0, start0, end0, frac0, ring1, ringAndEdge1, start1, end1, frac1, unique){
    return [isect, edge0, start0, end0, ringAndEdge1, start1, end1, unique, frac0, frac1, ring0, ring1];
  });
  var numSelfIsect = selfIsectsData.length;

  // If no self-intersections are found, we can simply return the feature as MultiPolygon, and compute its winding number
  if (numSelfIsect == 0) {
    var outerRingWinding = winding(feature.geometry.coordinates[0]);
    var outputFeatures = [helpers.polygon([feature.geometry.coordinates[0]],{parent: -1, winding: outerRingWinding, netWinding: outerRingWinding})];
    for(var i = 1; i < numRings; i++) {
      var currentRingWinding = winding(feature.geometry.coordinates[i]);
      outputFeatures.push(helpers.polygon([feature.geometry.coordinates[i]],{parent: 0, winding: currentRingWinding, netWinding: outerRingWinding + currentRingWinding}));
    }
    return helpers.featureCollection(outputFeatures);
  }

  // Build pseudo vertex list and intersection list
  var pseudoVtxListByRingAndEdge = []; // An Array with for each edge an Array containing the pseudo-vertices (as made by their constructor) that have this edge as ringAndEdgeIn, sorted by their fractional distance on this edge.
  var isectList = []; // An Array containing intersections (as made by their constructor). First all polygon-vertex-intersections, then all self-intersections. The order of the latter is not important but is permanent once given.
  // Push polygon-pseudo-vertex to pseudoVtxListByRingAndEdge and polygon-vertex-intersections to isectList
  for (var i = 0; i < numRings; i++) {
    pseudoVtxListByRingAndEdge.push([]);
    for (var j = 0; j < feature.geometry.coordinates[i].length-1; j++) {
      // Each edge will feature one polygon-pseudo-vertex in its array, on the last position. i.e. edge j features the polygon-pseudo-vertex of the polygon vertex j+1, with ringAndEdgeIn = j, on the last position.
    	pseudoVtxListByRingAndEdge[i].push([new PseudoVtx(feature.geometry.coordinates[i][(j+1).mod(feature.geometry.coordinates[i].length-1)], 1, [i, j], [i, (j+1).mod(feature.geometry.coordinates[i].length-1)], undefined)]);
      // The first numPolyVertices elements in isectList correspong to the polygon-vertex-intersections
      isectList.push(new Isect(feature.geometry.coordinates[i][j], [i, (j-1).mod(feature.geometry.coordinates[i].length-1)], [i, j], undefined, undefined, false, true));
    }
  }
  // Push intersection-pseudo-vertices to pseudoVtxListByRingAndEdge and self-intersections to isectList
  for (var i = 0; i < numSelfIsect; i++) {
    // Add intersection-pseudo-vertex made using selfIsectsData to pseudoVtxListByRingAndEdge's array corresponding to the incomming edge
    pseudoVtxListByRingAndEdge[selfIsectsData[i][10]][selfIsectsData[i][1]].push(new PseudoVtx(selfIsectsData[i][0], selfIsectsData[i][8], [selfIsectsData[i][10], selfIsectsData[i][1]], [selfIsectsData[i][11], selfIsectsData[i][4]], undefined));
    // selfIsectsData contains double mentions of each intersection, but we only want to add them once to isectList
    if (selfIsectsData[i][7]) isectList.push(new Isect(selfIsectsData[i][0], [selfIsectsData[i][10], selfIsectsData[i][1]], [selfIsectsData[i][11], selfIsectsData[i][4]], undefined, undefined, true, true));
  }
  var numIsect = isectList.length;
  // Sort Arrays of pseudoVtxListByRingAndEdge by the fraction distance 'param' using compare function
  for (var i = 0; i < pseudoVtxListByRingAndEdge.length; i++) {
    for (var j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++) {
      pseudoVtxListByRingAndEdge[i][j].sort(function(a, b){
      if(a.param < b.param) return -1;
      if(a.param > b.param) return 1;
      return 0;
      });
    }
  }

  // Find 'nxtIsect' for each pseudo-vertex in pseudoVtxListByRingAndEdge
  // Do this by comparing coordinates to isectList
  for (var i = 0; i < pseudoVtxListByRingAndEdge.length; i++){
    for (var j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++){
      for (var k = 0; k < pseudoVtxListByRingAndEdge[i][j].length; k++){
        var foundNextIsect = false;
        for (var l = 0; (l < numIsect) && !foundNextIsect; l++) {
          if (k == pseudoVtxListByRingAndEdge[i][j].length-1) {
            if (isectList[l].coord.equals(pseudoVtxListByRingAndEdge[i][(j+1).mod(feature.geometry.coordinates[i].length-1)][0].coord)) {
              pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn = l; // For polygon-pseudo-vertices, this is wrongly called nxtIsectAlongEdgeIn, as it is actually the next one along ringAndEdgeOut. This is dealt with correctly in the next block.
              foundNextIsect = true;
            }
          } else {
            if (isectList[l].coord.equals(pseudoVtxListByRingAndEdge[i][j][k+1].coord)) {
              pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn = l;
              foundNextIsect = true;
            }
          }
        }
      }
    }
  }

  // Find ('nxtIsectAlongRingAndEdge1' and) 'nxtIsectAlongRingAndEdge2' for each intersection in isectList
  // For polygon-vertex-intersections, find 'nxtIsectAlongRingAndEdge2' the pseudo-vertex corresponding to intersection i is the last element of in the Array of pseudoVtxListByRingAndEdge corresponding to the (i-1)-th edge. Whe can this find the next intersection there, and correct the misnaming that happened in the previous block, since ringAndEdgeOut = ringAndEdge2 for polygon vertices.
  var i = 0;
  for (var j = 0; j < pseudoVtxListByRingAndEdge.length; j++) {
    for (var k = 0; k < pseudoVtxListByRingAndEdge[j].length; k++) {
      isectList[i].nxtIsectAlongRingAndEdge2 = pseudoVtxListByRingAndEdge[j][(k-1).mod(pseudoVtxListByRingAndEdge[j].length)][pseudoVtxListByRingAndEdge[j][(k-1).mod(pseudoVtxListByRingAndEdge[j].length)].length-1].nxtIsectAlongEdgeIn;
      i++
    }
  }
  // For self-intersections, find 'nxtIsectAlongRingAndEdge1' and 'nxtIsectAlongRingAndEdge2' by comparing coordinates to pseudoVtxListByRingAndEdge and looking at the nxtIsectAlongEdgeIn property, depending on how the edges are labeled in the pseudo-vertex
  for (var i = numPolyVertices; i < numIsect; i++) {
    var foundEgde1In = foundEgde2In = false;
    for (var j = 0; (j < pseudoVtxListByRingAndEdge.length) && !(foundEgde1In && foundEgde2In); j++) {
      for (var k = 0; (k < pseudoVtxListByRingAndEdge[j].length) && !(foundEgde1In && foundEgde2In); k++) {
        for (var l = 0; (l < pseudoVtxListByRingAndEdge[j][k].length) && !(foundEgde1In && foundEgde2In); l++) {
          if (isectList[i].coord.equals(pseudoVtxListByRingAndEdge[j][k][l].coord)) { // This will happen twice
            if (isectList[i].ringAndEdge1.equals(pseudoVtxListByRingAndEdge[j][k][l].ringAndEdgeIn)) {
              isectList[i].nxtIsectAlongRingAndEdge1 = pseudoVtxListByRingAndEdge[j][k][l].nxtIsectAlongEdgeIn;
               foundEgde1In = true;
            } else {
              isectList[i].nxtIsectAlongRingAndEdge2 = pseudoVtxListByRingAndEdge[j][k][l].nxtIsectAlongEdgeIn;
              foundEgde2In = true;
            }
          }
        }
      }
    }
  }

  // Find the polygon vertex with lowest x-value. This vertex's intersection is certainly part of only one outermost simple polygon
  var firstRingFistIsect = 0;
  for (var i = 0; i < numPolyVertices; i++) {
    if (isectList[i].coord[0] < isectList[firstRingFistIsect].coord[0]) {
      firstRingFistIsect = i;
    }
  }
  // Find the intersection before and after it
  var firstRingSecondIsect = isectList[firstRingFistIsect].nxtIsectAlongRingAndEdge2;
  for (var i = 0; i < isectList.length; i++) {
    if ((isectList[i].nxtIsectAlongRingAndEdge1 == firstRingFistIsect) || (isectList[i].nxtIsectAlongRingAndEdge2 == firstRingFistIsect)) {
      var firstRingLastIsect = i;
      break
    }
  }
  // Use them to determine the winding number of this first polygon. An extremal vertex of a simple polygon is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
  if (isConvex([isectList[firstRingLastIsect].coord,isectList[firstRingFistIsect].coord,isectList[firstRingSecondIsect].coord],true)) {
    firstRingWinding = 1;
  } else {
    firstRingWinding = -1;
  }

  // Initialise the queues
  var isectQueue = [firstRingFistIsect]; // Queue of intersections to start new simple polygon from
  var parentQueue = [-1]; // Queue of the parent polygon of polygon started from the corresponding intersection in the isectQueue
  var windingQueue = [firstRingWinding];

  // Initialise output
  var outputFeatures = [];

  // While intersection queue is not empty, take the first intersection out and start making a simple polygon in the direction that has not been walked away over yet.
  while (isectQueue.length>0) {
    // Get the first objects out of the queue
    var startIsect = isectQueue.shift();
    var currentRingParent = parentQueue.shift();
    var currentRingWinding = windingQueue.shift();
    var currentRingNetWinding = (currentRingParent == -1) ? currentRingWinding : outputFeatures[currentRingParent].properties.winding + currentRingWinding;
    // Make new output ring and add vertex from starting intersection
    var currentRing = outputFeatures.length-1;
    var currentRingCoords = [isectList[startIsect].coord];
    if (debug) console.log("# Now at ring number "+(outputFeatures.length-1));
    // Set up the variables used while walking through intersections: 'currentIsect', 'nxtIsect' and 'walkingRingAndEdge'
    var currentIsect = startIsect;
    if (isectList[startIsect].ringAndEdge1Walkable) {
      var walkingRingAndEdge = isectList[startIsect].ringAndEdge1;
      var nxtIsect = isectList[startIsect].nxtIsectAlongRingAndEdge1;
    } else {
      var walkingRingAndEdge = isectList[startIsect].ringAndEdge2;
      var nxtIsect = isectList[startIsect].nxtIsectAlongRingAndEdge2;
    }
    // While we have not arrived back at the same intersection, keep walking
    while (!isectList[startIsect].coord.equals(isectList[nxtIsect].coord)){
      if (debug) console.log("Walking from intersection "+currentIsect+" to "+nxtIsect+" over ring "+walkingRingAndEdge[0]+" and edge "+walkingRingAndEdge[1]);
      if (debug) console.log("Current state of queues: \nIntersections: "+JSON.stringify(isectQueue)+"\nParents: "+JSON.stringify(parentQueue)+"\nWindings: "+JSON.stringify(windingQueue));
      currentRingCoords.push(isectList[nxtIsect].coord);
      if (debug) console.log("Added intersection "+nxtIsect+" to current ring");
      // If the next intersection is queued, we can remove it, because we will go there now
      if (isectQueue.indexOf(nxtIsect) >= 0) {
        if (debug) console.log("Removing intersection "+nxtIsect+" from queue");
        parentQueue.splice(isectQueue.indexOf(nxtIsect),1);
        windingQueue.splice(isectQueue.indexOf(nxtIsect),1);
        isectQueue.splice(isectQueue.indexOf(nxtIsect),1); // remove intersection one last, since its index is used by the others
      }
      // Remeber which edge we will now walk over (if we came from 1 we will walk away from 2 and vice versa),
      // add the intersection to the queue if we have never walked away over the other edge,
      // queue the parent and winding number (if the edge is convex, the next ring will have the alternate winding and lie outside of the current one, and thus have the same parent ring as the current ring. Otherwise, it will have the same winding number and lie inside of the current ring)
      // and update walking variables.
      // The properties to adjust depend on what edge we are walking over.
      if (walkingRingAndEdge.equals(isectList[nxtIsect].ringAndEdge1)) {
        isectList[nxtIsect].ringAndEdge2Walkable = false;
        if (isectList[nxtIsect].ringAndEdge1Walkable) {
          if (debug) console.log("Adding intersection "+nxtIsect+" to queue");
          isectQueue.push(nxtIsect);
          if (isConvex([isectList[currentIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongRingAndEdge2].coord],currentRingWinding == 1)) {
            parentQueue.push(currentRingParent);
            windingQueue.push(-currentRingWinding);
          } else {
            parentQueue.push(currentRing);
            windingQueue.push(currentRingWinding);
          }
        }
        currentIsect = nxtIsect;
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge2;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongRingAndEdge2;
      } else {
        isectList[nxtIsect].ringAndEdge1Walkable = false;
        if (isectList[nxtIsect].ringAndEdge2Walkable) {
          if (debug) console.log("Adding intersection "+nxtIsect+" to queue");
          isectQueue.push(nxtIsect);
          if (isConvex([isectList[currentIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongRingAndEdge1].coord],currentRingWinding == 1)) {
            parentQueue.push(currentRingParent);
            windingQueue.push(-currentRingWinding);
          } else {
            parentQueue.push(currentRing);
            windingQueue.push(currentRingWinding);
          }
        }
        currentIsect = nxtIsect;
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge1;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongRingAndEdge1;
      }
    }
    currentRingCoords.push(isectList[nxtIsect].coord); // close ring
    outputFeatures.push(helpers.polygon([currentRingCoords],{parent: currentRingParent, winding: currentRingWinding, netWinding: currentRingNetWinding}));
  }
  if (debug) console.log("# Total of "+outputFeatures.length+" rings");

  return helpers.featureCollection(outputFeatures);
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

// Method to check if array is unique (i.e. all unique elements, i.e. no duplicate elements)
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

// Function to determine if three consecutive points of a polygon make up a convex vertex, assuming the polygon is right- or lefthanded
function isConvex(pts, righthanded){
  if (typeof(righthanded) === 'undefined') righthanded = true;
  if (pts.length != 3) throw new Error("This function requires an array of three points [x,y]");
  var d = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]);
  return (d >= 0) == righthanded;
}

// Function to compute winding of simple, non-self-intersecting polygon (ring is an array of [x,y] pairs with the last equal to the first)
function winding(ring){
  // Compute the winding number based on the vertex with the lowest x-value, it precessor and successor. An extremal vertex of a simple polygon is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
  var lowestVtx = 0;
  for (var i = 0; i < ring.length-1; i++) { if (ring[i][0] < ring[lowestVtx][0]) lowestVtx = i; }
  if (isConvex([ring[(lowestVtx-1).mod(ring.length-1)],ring[lowestVtx],ring[(lowestVtx+1).mod(ring.length-1)]],true)) {
    var winding = 1;
  } else {
    var winding = -1;
  }
  return winding
}
