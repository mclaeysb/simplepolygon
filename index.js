var fs = require('fs');
var isects = require('2d-polygon-self-intersections');

/**
* Takes a complex (i.e. self-intersecting) polygon, and returns a MultiPolygon of the simple polygons it is composed of.
*
* @module simplepolygon
* @param {(Feature|FeatureCollection)} feature input to be buffered
* @param {Number} distance distance to draw the buffer
* @param {String} unit 'miles', 'feet', 'kilometers', 'meters', or 'degrees'
* @return {FeatureCollection<Polygon>|FeatureCollection<MultiPolygon>|Polygon|MultiPolygon} buffered features
*
* @example
* var poly = {
*   "type": "Feature",
*   "properties": {},
*   "geometry": {
*     "type": "Polygon",
*     "coordinates": [[[],[],[],[]]]
*   }
* };
* var unit = 'miles';
*
* var buffered = turf.buffer(pt, 500, unit);
* var result = turf.featurecollection([buffered, pt]);
*
* //=result
*/

/*
  This algorithm works by walking from intersection to intersection over edges in their original direction, and making polygons by storing their vertices. Each intersection knows which is the next one given the edge we came over. When walking, we store where we have walked (since we must only walk over each (part of an) edge once), and keep track of intersections we encounter but have not walked away from in the other direction. We start at an outer polygon intersection to compute a first simple polygon. Once done, we use the queue to compute the polygon. By remembering how the polygons are nested and computing each polygons winding number, we can also compute the total winding numbers.

  Some notes:
  - The edges are oriented from their first to their second polygon vertrex
  - At an intersection of two edges, two pseudo-vertices are present.
  - A pseudo-vertex has an incomming and outgoing (crossing) edge. The edges which roles in the other pseudo-vertex
  - At a polygon vertex, one pseudo-vertex is present.
  - We use the terms 'polygon edge', 'polygon vertex', 'self-intersection vertex', 'intersection' (which includes polygon-vertex-intersection and self-intersection) and 'pseudo-vertex' (which includes 'polygon-pseudo-vertex' and 'intersection-pseudo-vertex')
  - The following objects are stored and passed by the index in the list between brackets: Polygon vertices and edges (inputPoly), intersections (isectList) and pseudo-vertices (pseudoVtxListByEdge)
  - The above, however, explains why pseudo-vertices have the property 'nxtIsectAlongEdgeIn' (which is easy to find out and used later for nxtIsectAlongEdge1 and nxtIsectAlongEdge2) in stead of some propery 'nxtPseudoVtxAlongEdgeOut'
  - inputPoly is a list of [x,y] coordinates, outputPolyArray is a list of a list of [x,y] coordinates. They are nested one step less than polygons in geojson, since we are not working with interior rings.

  Currently, intersections are computed using the isects package, from https://www.npmjs.com/package/2d-polygon-self-intersections
	For n segments and k intersections,	this is O(n^2)
  This is approximately the most expensive part of the algorithm
  It can be optimised to O((n + k) log n) through Bentley–Ottmann algorithm (which is an improvement for small k (k < o(n2 / log n)))
  See possibly https://github.com/e-cloud/sweepline
	Future work this algorithm to allow interior LinearRing's and/or multipolygon input, since main.js should be enabled to handle multipolygon input.

  This code differs from the algorithms and nomenclature of the article it is insired on in the following way:
  - No constructors are used, except 'PseudoVtx' and 'Isect'
  - 'LineSegments' of the polygon are called 'edges' here, and are represented, when necessary, by the index of their first point
  - 'edgeOut' is called 'l' in the article
  - 'PseudoVtx' is called 'nVtx'
  - 'Isect' is called 'intersection'
  - 'nxtIsectAlongEdgeIn' is called 'index'
  - 'edge1' and 'edge2' are named 'origin1' and 'origin2'
  - 'winding' is not implemented as a propoerty of an intersection, but as its own queue
  - 'pseudoVtxListByEdge' is called 'polygonEdgeArray'
  - 'pseudoVtxListByEdge' contains the polygon vertex at its end as the last item, and not the polygon vertex at its start as the first item
  - 'isectList' is called 'intersectionList'
  - 'isectQueue' is called 'intersectioQueue'
*/

// Constructor for (polygon- or intersection-) pseudo-vertices. There are two per intersection.
var PseudoVtx = function (coord, param, edgeIn, edgeOut, nxtIsectAlongEdgeIn) {
  this.coord = coord; // [x,y] of this pseudo-vertex
  this.param = param; // fractional distance of this intersection on incomming polygon edge
  this.edgeIn = edgeIn; // incomming polygon edge
  this.edgeOut = edgeOut; // outgoing polygon edge
  this.nxtIsectAlongEdgeIn = nxtIsectAlongEdgeIn; // The next intersection when following the incomming polygon edge (so not when following edgeOut!)
}

// Constructor for a intersection. If the input polygon points are unique, there are two intersection-pseudo-vertices per self-intersection and one polygon-pseudo-vertex per polygon-vertex-intersection. Their labels 1 and 2 are not assigned a particular meaning but are permanent once given.
var Isect = function (coord, edge1, edge2, nxtIsectAlongEdge1, nxtIsectAlongEdge2, Edge1Walkable, Edge2Walkable) {
  this.coord = coord; // [x,y] of this intersection
  this.edge1 = edge1; // first edge of this intersection
  this.edge2 = edge2; // second edge of this intersection
  this.nxtIsectAlongEdge1 = nxtIsectAlongEdge1; // the next intersection when following edge1
  this.nxtIsectAlongEdge2 = nxtIsectAlongEdge2; // the next intersection when following edge2
  this.Edge1Walkable = Edge1Walkable; // May we (still) walk away from this intersection over edge1?
  this.Edge2Walkable = Edge2Walkable; // May we (still) walk away from this intersection over edge2?
}


module.exports = function(feature) {

  var debug = true;

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

  // If no self-intersections are found, we can simple return the feature as MultiPolygon, and compute its winding number
  if (numIsect == 0) {
    // Compute the winding number based on the vertex with the lowest x-value, it precessor and successor. An extremal vertex of a simple polygon is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
    var lowestVtx = 0;
    for (var i = 0; i < numPolyVertices; i++) { if (inputPoly[i][0] < inputPoly[lowestVtx][0]) lowestVtx = i; }
    if (isConvex([inputPoly[(lowestVtx-1).mod(numPolyVertices)],inputPoly[lowestVtx],inputPoly[(lowestVtx+1).mod(numPolyVertices)]],true)) {
      var winding = 1;
    } else {
      var winding = -1;
    }
    feature.geometry.type = 'MultiPolygon';
    feature.geometry.coordinates = [feature.geometry.coordinates];
    feature.properties.parent = -1;
    feature.properties.winding = winding;
    feature.properties.netWinding = winding;
    return feature;
  }

  // Build intersection master list and polygon edge array
  var pseudoVtxListByEdge = []; // An Array with for each edge an Array containing the pseudo-vertices (as made by their constructor) that have this edge as edgeIn, sorted by their fractional distance on this edge.
  var isectList = []; // An Array containing intersections (as made by their constructor). First all polygon-vertex-intersections, then all self-intersections. The order of the latter is not important but is permanent once given.
  // Push polygon-pseudo-vertex to pseudoVtxListByEdge and polygon-vertex-intersections to isectList
  for (var i = 0; i < numPolyVertices; i++) {
    // Each edge will feature one polygon-pseudo-vertex in its array, on the last position. I.e. edge i features the polygon-pseudo-vertex of the polygon vertex i+1, with edgeIn = i, on the last position.
  	pseudoVtxListByEdge.push([new PseudoVtx(inputPoly[(i+1).mod(numPolyVertices)], 1, i, (i+1).mod(numPolyVertices), undefined)]);
    // The first numPolyVertices elements in isectList correspong to the polygon-vertex-intersections
    isectList.push(new Isect(inputPoly[i], (i-1).mod(numPolyVertices), i, undefined, undefined, false, true));
  }
  // Push intersection-pseudo-vertices to pseudoVtxListByEdge and self-intersections to isectList
  for (var i = 0; i < numIsect; i++) {
    // Add intersection-pseudo-vertex made using isectsData to pseudoVtxListByEdge's array corresponding to the incomming edge
    pseudoVtxListByEdge[isectsData[i][1]].push(new PseudoVtx(isectsData[i][0], isectsData[i][8], isectsData[i][1], isectsData[i][4], undefined));
    // isectsData contains double mentions of each intersection, but we only want to add them once to isectList
    if (isectsData[i][7]) isectList.push(new Isect(isectsData[i][0], isectsData[i][1], isectsData[i][4], undefined, undefined, true, true));
  }
  // Sort Arrays of pseudoVtxListByEdge by the fraction distance 'param' using compare function
  for (var i = 0; i < numPolyVertices; i++) {
    pseudoVtxListByEdge[i].sort(function(a, b){
    if(a.param < b.param) return -1;
    if(a.param > b.param) return 1;
    return 0;
    });
  }

  // Find 'nxtIsect' for each pseudo-vertex in pseudoVtxListByEdge
  // Do this by comparing coordinates to isectList
  for (var i = 0; i < numPolyVertices; i++){
    for (var j = 0; j < pseudoVtxListByEdge[i].length; j++){
      var foundNextIsect = false;
      for (var k = 0; (k < numIsect) && !foundNextIsect; k++) {
        // Check if you found nxtIsect (different if last one)
        if (j == pseudoVtxListByEdge[i].length-1) {
          if (isectList[k].coord.equals(pseudoVtxListByEdge[(i+1).mod(numPolyVertices)][0].coord)) {
            pseudoVtxListByEdge[i][j].nxtIsectAlongEdgeIn = k; // For polygon-pseudo-vertices, this is wrongly called nxtIsectAlongEdgeIn, as it is actually the next one along edgeOut. This is dealt with correctly in the next block.
            foundNextIsect = true;
          }
        } else {
          if (isectList[k].coord.equals(pseudoVtxListByEdge[i][j+1].coord)) {
            pseudoVtxListByEdge[i][j].nxtIsectAlongEdgeIn = k;
            foundNextIsect = true;
          }
        }
      }
    }
  }

  // Find ('nxtIsectAlongEdge1' and) 'nxtIsectAlongEdge2' for each intersection in isectList
  // For polygon-vertex-intersections, find 'nxtIsectAlongEdge2' the pseudo-vertex corresponding to intersection i is the last element of in the Array of pseudoVtxListByEdge corresponding to the (i-1)-th edge. Whe can this find the next intersection there, and correct the misnaming that happened in the previous block, since edgeOut = edge2 for polygon vertices.
  for (var i = 0; i < numPolyVertices; i++) {
    isectList[i].nxtIsectAlongEdge2 = pseudoVtxListByEdge[(i-1).mod(numPolyVertices)][pseudoVtxListByEdge[(i-1).mod(numPolyVertices)].length-1].nxtIsectAlongEdgeIn;
  }
  // For self-intersections, find 'nxtIsectAlongEdge1' and 'nxtIsectAlongEdge2' by comparing coordinates to pseudoVtxListByEdge and looking at the nxtIsectAlongEdgeIn property, depending on how the edges are labeled in the pseudo-vertex
  for (var i = numPolyVertices; i < numIsect; i++) {
    var foundEgde1In = foundEgde2In = false;
    for (var j = 0; (j < numPolyVertices) && !(foundEgde1In && foundEgde2In); j++) {
      for (var k = 0; (k < pseudoVtxListByEdge[j].length) && !(foundEgde1In && foundEgde2In); k++) {
        if (isectList[i].coord.equals(pseudoVtxListByEdge[j][k].coord)) { // This will happen twice
          if (isectList[i].edge1 == pseudoVtxListByEdge[j][k].edgeIn) {
            isectList[i].nxtIsectAlongEdge1 = pseudoVtxListByEdge[j][k].nxtIsectAlongEdgeIn;
             foundEgde1In = true;
          } else {
            isectList[i].nxtIsectAlongEdge2 = pseudoVtxListByEdge[j][k].nxtIsectAlongEdgeIn;
            foundEgde2In = true;
          }
        }
      }
    }
  }

  // Find the polygon vertex with lowest x-value. This vertex's intersection is certainly part of only one outermost simple polygon
  var firstPolyFirstIsect = 0;
  for (var i = 0; i < numPolyVertices; i++) {
    if (inputPoly[i][0] < inputPoly[firstPolyFirstIsect][0]) {
      firstPolyFirstIsect = i;
    }
  }
  // Find the intersection before and after it
  var firstPolySecondIsect = isectList[firstPolyFirstIsect].nxtIsectAlongEdge2;
  for (var i = 0; i < isectList.length; i++) {
    if ((isectList[i].nxtIsectAlongEdge1 == firstPolyFirstIsect) || (isectList[i].nxtIsectAlongEdge2 == firstPolyFirstIsect)) {
      var firstPolyLastIsect = i;
      break
    }
  }
  // Use them to determine the winding number of this first polygon. An extremal vertex of a simple polygon is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
  if (isConvex([isectList[firstPolyLastIsect].coord,isectList[firstPolyFirstIsect].coord,isectList[firstPolySecondIsect].coord],true)) {
    firstPolyWinding = 1;
  } else {
    firstPolyWinding = -1;
  }

  // Initialise the queues
  var isectQueue = [firstPolyFirstIsect]; // Queue of intersections to start new simple polygon from
  var parentQueue = [-1]; // Queue of the parent polygon of polygon started from the corresponding intersection in the isectQueue
  var windingQueue = [firstPolyWinding];

  // Initialise outputs
  var outputPolyArray = [];
  var outputParentArray = [];
  var outputWindingArray = [];
  var outputNetWindingArray = [];

  console.log(JSON.stringify(pseudoVtxListByEdge,null,2));
  console.log("---");
  console.log(JSON.stringify(isectList,null,2));

  // While intersection queue is not empty, take the first intersection out and start making a simple polygon in the direction that has not been walked away over yet.
  while (isectQueue.length>0) {
    // Get the first objects out of the queue
    var startIsect = isectQueue.shift();
    var thisPolyParent = parentQueue.shift();
    var thisPolyWinding = windingQueue.shift();
    // Make new output polygon and add vertex from starting intersection
    outputPolyArray.push([[]]);
    var thisPoly = outputPolyArray.length-1;
    outputPolyArray[thisPoly][0].push(isectList[startIsect].coord);
    if (debug) console.log("# Now at polygon number "+(thisPoly));
    // Add the properties of this new polygon
    outputParentArray.push(thisPolyParent);
    outputWindingArray.push(thisPolyWinding);
    outputNetWindingArray.push((outputWindingArray[thisPolyParent]||0)+thisPolyWinding);
    // Set up the variables used while walking through intersections: 'thisIsect', 'nxtIsect' and 'walkingEdge'
    var thisIsect = startIsect;
    if (isectList[startIsect].Edge1Walkable) {
      var walkingEdge = isectList[startIsect].edge1;
      var nxtIsect = isectList[startIsect].nxtIsectAlongEdge1;
    } else {
      var walkingEdge = isectList[startIsect].edge2;
      var nxtIsect = isectList[startIsect].nxtIsectAlongEdge2;
    }
    // While we have not arrived back at the same intersection, keep walking
    while (!isectList[startIsect].coord.equals(isectList[nxtIsect].coord)){
      if (debug) console.log("Walking from intersection "+thisIsect+" to "+nxtIsect+" over edge "+walkingEdge);
      if (debug) console.log("Current state of queues: \nIntersections: "+JSON.stringify(isectQueue)+"\nParents: "+JSON.stringify(parentQueue)+"\nWindings: "+JSON.stringify(windingQueue));
      outputPolyArray[thisPoly][0].push(isectList[nxtIsect].coord);
      if (debug) console.log("Added intersection "+nxtIsect+" to this polygon");
      // If the next intersection is queued, we can remove it, because we will go there now
      if (isectQueue.indexOf(nxtIsect) >= 0) {
        if (debug) console.log("Removing intersection "+nxtIsect+" from queue");
        parentQueue.splice(isectQueue.indexOf(nxtIsect),1);
        windingQueue.splice(isectQueue.indexOf(nxtIsect),1);
        isectQueue.splice(isectQueue.indexOf(nxtIsect),1); // remove this one last
      }
      // Remeber which edge we will now walk over (if we came from 1 we will walk away from 2 and vice versa),
      // add the intersection to the queue if we have never walked away over the other edge,
      // queue the parent and winding number (if the edge is convex, the next polygon will have the alternate winding and lie outside of the current one, and thus have the same parent polygon as the current polygon. Otherwise, it will have the same winding number and lie inside of the current polygon)
      // and update walking variables.
      // The properties to adjust depend on what edge we are walking over.
      if (walkingEdge == isectList[nxtIsect].edge1) {
        isectList[nxtIsect].Edge2Walkable = false;
        if (isectList[nxtIsect].Edge1Walkable) {
          if (debug) console.log("Adding intersection "+nxtIsect+" to queue");
          isectQueue.push(nxtIsect);
          if (isConvex([isectList[thisIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongEdge2].coord],thisPolyWinding == 1)) {
            parentQueue.push(thisPolyParent);
            windingQueue.push(-thisPolyWinding);
          } else {
            parentQueue.push(thisPoly);
            windingQueue.push(thisPolyWinding);
          }
        }
        thisIsect = nxtIsect;
        walkingEdge = isectList[nxtIsect].edge2;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongEdge2;
      } else {
        isectList[nxtIsect].Edge1Walkable = false;
        if (isectList[nxtIsect].Edge2Walkable) {
          if (debug) console.log("Adding intersection "+nxtIsect+" to queue");
          isectQueue.push(nxtIsect);
          if (isConvex([isectList[thisIsect].coord, isectList[nxtIsect].coord, isectList[isectList[nxtIsect].nxtIsectAlongEdge1].coord],thisPolyWinding == 1)) {
            parentQueue.push(thisPolyParent);
            windingQueue.push(-thisPolyWinding);
          } else {
            parentQueue.push(thisPoly);
            windingQueue.push(thisPolyWinding);
          }
        }
        thisIsect = nxtIsect;
        walkingEdge = isectList[nxtIsect].edge1;
        nxtIsect = isectList[nxtIsect].nxtIsectAlongEdge1;
      }
    }
    outputPolyArray[thisPoly][0].push(isectList[nxtIsect].coord); // close polygon
  }
  if (debug) console.log("# Total of "+outputPolyArray.length+" simple polygons");

  feature.geometry.type = 'MultiPolygon';
  feature.geometry.coordinates = outputPolyArray;
  feature.properties.parent = outputParentArray;
  feature.properties.winding = outputWindingArray;
  feature.properties.netWinding = outputNetWindingArray;
  return feature;
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

// Function to determine if three consecutive points of a polygon make up a convex vertex, assuming the polygon is right- or lefthanded
function isConvex(pts, righthanded){
  if (typeof(righthanded) === 'undefined') righthanded = true;
  if (pts.length != 3) throw new Error("This function requires an array of three points [x,y]");
  var d = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]);
  return (d >= 0) == righthanded;
}
