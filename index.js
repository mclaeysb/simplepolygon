var isects = require('../geojson-polygon-self-intersections');
var helpers = require('turf-helpers');
var within = require('turf-within');
var area = require('turf-area');

/**
* Takes a complex (i.e. self-intersecting) polygon, and breaks it down into its composite simple polygons.
*
* @module simplepolygon
* @param {Feature} feature input polygon. This feature may break with {@link http://geojson.org/geojson-spec.html|geojson specs} in the sense that it's inner and outer rings may intersect or self-intersect.
* @return {FeatureCollection} Feature collection containing the simple polygon features the complex polygon is composed of. These simple polygons only including their properties such as their parent polygon, winding number and net winding number
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

  var debug = true;

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
  // TODO: add to comments: extra layer for rings. + Simple polygon, even stricter: only outer ring
  // TODO: add all polygon vertex intersections to isectQueue (and remove them too) such that inner rings without self-interections are also traversed

  // TODO: reorder selfIsectsData. Also reorder isect: walkable after edge
  // Compute self-intersections
  var selfIsectsData = isects(feature, function filterFn(isect, ring0, edge0, start0, end0, frac0, ring1, ringAndEdge1, start1, end1, frac1, unique){
    return [isect, edge0, start0, end0, ringAndEdge1, start1, end1, unique, frac0, frac1, ring0, ring1];
  });
  var numSelfIsect = selfIsectsData.length;

  /*
  // If no self-intersections are found, we can simply return the feature as MultiPolygon, and compute its winding number
  if (numSelfIsect == 0) {
    var outerRingWinding = windingOfRing(feature.geometry.coordinates[0]);
    var outputFeatureArray = [helpers.polygon([feature.geometry.coordinates[0]],{parent: -1, winding: outerRingWinding, netWinding: outerRingWinding})];
    for(var i = 1; i < numRings; i++) {
      var currentRingWinding = windingOfRing(feature.geometry.coordinates[i]);
      outputFeatureArray.push(helpers.polygon([feature.geometry.coordinates[i]],{parent: 0, winding: currentRingWinding, netWinding: outerRingWinding + currentRingWinding}));
    }
    return helpers.featureCollection(outputFeatureArray);
  }
  */

  // Build pseudo vertex list and intersection list
  var pseudoVtxListByRingAndEdge = []; // An Array with for each edge an Array containing the pseudo-vertices (as made by their constructor) that have this edge as ringAndEdgeIn, sorted by their fractional distance on this edge.
  var isectList = []; // An Array containing intersections (as made by their constructor). First all polygon-vertex-intersections, then all self-intersections. The order of the latter is not important but is permanent once given.
  // Push polygon-pseudo-vertices to pseudoVtxListByRingAndEdge and polygon-vertex-intersections to isectList
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


  // Initialise the queues
  // Queue of intersections to start new simple polygon from. For each ring, the polygon-vertex-intersections with the lowest x-value will be added. If it will be encountered while walking, it will be removed. If after finishing all walks initiated by the first intersection popped from this queue it has not been encountered, it will still be in the queue and a new set of walks will be initiated from it.
  var isectQueue = [];
  // Queue of the parent polygon of the polygon started from the corresponding intersection in the isectQueue. For now, we assume that the (outer) simple polygons initiated from a polygon-vertex-intersections have no parent. If these polygons happen to lie within other simple polygons (with which they don't touch or intersect), this will be corrected for later.
  var parentQueue = [];
  var windingQueue = [];
  // For each ring, add the polygon-vertex-intersection with the lowest x-value, and its corresponding parent and winding number to the queue.
  var i = 0;
  for (var j = 0; j < numRings; j++) {
    var lowestIsect = i;
    for (var k = 0; k < feature.geometry.coordinates[j].length-1; k++) {
      if (isectList[i].coord[0] < isectList[lowestIsect].coord[0]) {
        lowestIsect = i;
      }
      i++;
    }
    // Compute winding at the lowest polygon-vertex-intersection. We thus this by using our knowledge that this extremal vertex must be a convex vertex.
    // Find the intersection before and after it
    var isectAfterLowestIsect = isectList[lowestIsect].nxtIsectAlongRingAndEdge2;
    for (var k = 0; k < isectList.length; k++) {
      if ((isectList[k].nxtIsectAlongRingAndEdge1 == lowestIsect) || (isectList[k].nxtIsectAlongRingAndEdge2 == lowestIsect)) {
        var isectBeforeLowestIsect = k;
        break
      }
    }
    // Use them to determine the winding number of this first polygon. An extremal vertex of a simple polygon is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
    var windingAtIsect = isConvex([isectList[isectBeforeLowestIsect].coord,isectList[lowestIsect].coord,isectList[isectAfterLowestIsect].coord],true) ? 1 : -1;

    isectQueue.push(lowestIsect);
    parentQueue.push(-1);
    windingQueue.push(windingAtIsect);
  }

  if (debug) console.log("The queues are initiated as follows:");
  if (debug) console.log(isectQueue);
  if (debug) console.log(parentQueue);
  if (debug) console.log(windingQueue);

  // Initialise output
  var outputFeatureArray = [];

  // While intersection queue is not empty, take the first intersection out and start making a simple polygon in the direction that has not been walked away over yet.
  while (isectQueue.length>0) {
    // Get the last objects out of the queue
    var startIsect = isectQueue.pop();
    var currentRingParent = parentQueue.pop();
    var currentRingWinding = windingQueue.pop();
    //var currentRingNetWinding = (currentRingParent == -1) ? currentRingWinding : outputFeatureArray[currentRingParent].properties.winding + currentRingWinding;
    // Make new output ring and add vertex from starting intersection
    var currentRing = outputFeatureArray.length;
    var currentRingCoords = [isectList[startIsect].coord];
    if (debug) console.log("# Now starting ring number "+outputFeatureArray.length+" from intersection "+startIsect);
    if (debug) if (startIsect < numPolyVertices) console.log("This is a polygon-vertex-intersections, which means this ring does not touch existing rings");
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
            console.log("--- a");
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
            console.log("--- b");
            console.log(currentRingWinding);
            console.log(currentIsect, nxtIsect, isectList[nxtIsect].nxtIsectAlongRingAndEdge1);
            console.log([isectList[currentIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongRingAndEdge1].coord]);
            console.log(isConvex([isectList[currentIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongRingAndEdge1].coord],currentRingWinding == 1));
            parentQueue.push(currentRing);
            windingQueue.push(currentRingWinding);
          }
        }
        currentIsect = nxtIsect;
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge1;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongRingAndEdge1;
      }
    }
    if (debug) console.log("Walking from intersection "+currentIsect+" to "+nxtIsect+" over ring "+walkingRingAndEdge[0]+" and edge "+walkingRingAndEdge[1]+" and closing ring");
    currentRingCoords.push(isectList[nxtIsect].coord); // close ring
    var currentRingNetWinding = undefined
    outputFeatureArray.push(helpers.polygon([currentRingCoords],{index: currentRing, parent: currentRingParent, winding: currentRingWinding, netWinding: currentRingNetWinding}));
  }

  var output = helpers.featureCollection(outputFeatureArray);

  var featuresWithoutParent = [];
  for (var i = 0; i < output.features.length; i++) {
    console.log("Ring "+i+" has parent "+output.features[i].properties.parent);
    if (output.features[i].properties.parent == -1) featuresWithoutParent.push(i);
  }
  if (debug) console.log("The following output ring(s) have no parent: "+featuresWithoutParent);
  if (featuresWithoutParent.length > 1) {
    for (var i = 0; i < featuresWithoutParent.length; i++) {
      var parent = -1;
      var parentArea = Infinity;
      for (var j = 0; j < output.features.length; j++) {
        if (i == j) continue
        if (within(helpers.featureCollection([helpers.point(output.features[featuresWithoutParent[i]].geometry.coordinates[0][0])]),helpers.featureCollection([outputFeatureArray[j]])).features.length == 1) {
          if (area(output.features[j]) < parentArea) {
            parent = j;
            if (debug) console.log("Ring "+featuresWithoutParent[i]+" lies within ring "+j);
          }
        }
      }
      output.features[i].properties.parent = parent;
      if (debug) console.log("Ring "+i+" is assigned parent "+parent);
    }
  }

  for (var i = 0; i < output.features.length; i++) {
    if (output.features[i].properties.parent == -1) {
      // TODO: remove this check
      if (debug) if (windingOfRing(output.features[i].geometry.coordinates[0]) != output.features[i].properties.winding) console.log("ERROR: previously computed winding was wrong");
      var netWinding = output.features[i].properties.winding
      output.features[i].properties.netWinding = netWinding;
      setNetWindingOfChildren(i,netWinding)
    }
  }

  function setNetWindingOfChildren(parent,ParentNetWinding){
    for (var i = 0; i < output.features.length; i++) {
      if (output.features[i].properties.parent == parent){
        var netWinding = ParentNetWinding + output.features[i].properties.winding
        output.features[i].properties.netWinding = netWinding;
        setNetWindingOfChildren(i,netWinding)
      }
    }
  }


  // list which have parent -1 (here you will miss efficientcy of -1 creater by flipping: all those started from same polyvertex will be treated the same here)
  // if more than one, for those, check which is the smalles polygon (ring) they lie in (by storing this index and surface), and attrubute its parrent
  // for all that where in no-one and still have parent -1: compute netWinding downwards => more efficiently if sorted by parent first, then looking from index of parent

  // remove creator and flipWinding

  if (debug) console.log("# Total of "+output.features.length+" rings");

  return output;
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
function windingOfRing(ring){
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
