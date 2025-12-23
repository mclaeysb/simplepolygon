import gpsi, { equalArrays } from 'geojson-polygon-self-intersections'
import { point, polygon, featureCollection } from '@turf/helpers'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import area from '@turf/area'
import RBush from 'rbush'

import type { Feature, FeatureCollection, Polygon, Position } from 'geojson'

type QueueItem = { isect: number; parent: number; winding: number }
type RBushIsectItem = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  index: number
}

/**
 * Takes a complex (i.e. self-intersecting) geojson polygon, and breaks it down into its composite simple, non-self-intersecting one-ring polygons.
 *
 * @module simplepolygon
 * @param {Feature} feature Input polygon. This polygon may be unconform the {@link https://en.wikipedia.org/wiki/Simple_Features|Simple Features standard} in the sense that it's inner and outer rings may cross-intersect or self-intersect, that the outer ring must not contain the optional inner rings and that the winding number must not be positive for the outer and negative for the inner rings.
 * @return {FeatureCollection} Feature collection containing the simple, non-self-intersecting one-ring polygon features that the complex polygon is composed of. These simple polygons have properties such as their parent polygon, winding number and net winding number.
 *
 * @example
 * const poly = {
 *   "type": "Feature",
 *   "geometry": {
 *     "type": "Polygon",
 *     "coordinates": [[[0,0],[2,0],[0,2],[2,2],[0,0]]]
 *   }
 * };
 *
 * const result = simplepolygon(poly);
 *
 * // =result
 * // which will be a featureCollection of two polygons, one with coordinates [[[0,0],[2,0],[1,1],[0,0]]], parent -1, winding 1 and net winding 1, and one with coordinates [[[1,1],[0,2],[2,2],[1,1]]], parent -1, winding -1 and net winding -1
 */
export default function simplepolygon(
  feature: Feature<Polygon>
): FeatureCollection<Polygon> {
  // Check input
  if (feature.type != 'Feature')
    throw new Error('The input must a geojson object of type Feature')
  if (feature.geometry === undefined || feature.geometry == null)
    throw new Error('The input must a geojson object with a non-empty geometry')
  if (feature.geometry.type != 'Polygon')
    throw new Error('The input must be a geojson Polygon')

  // Process input
  const numRings = feature.geometry.coordinates.length
  const vertices: Position[] = []
  for (let i = 0; i < numRings; i++) {
    const ring = feature.geometry.coordinates[i]
    if (!equalArrays(ring[0], ring[ring.length - 1])) {
      ring.push(ring[0]) // Close input ring if it is not
    }
    vertices.push.apply(vertices, ring.slice(0, ring.length - 1))
  }
  if (vertices.length != new Set(vertices).size)
    throw new Error(
      'The input polygon may not have duplicate vertices (except for the first and last vertex of each ring)'
    )
  const numvertices = vertices.length // number of input ring vertices, with the last closing vertices not counted
  logger('Processing input')

  // Compute self-intersections
  const selfIsectsData = gpsi(feature, {
    callbackFunction: ({
      isect,
      ring0,
      edge0,
      start0,
      end0,
      frac0,
      ring1,
      edge1,
      start1,
      end1,
      frac1,
      unique
    }: {
      isect: Position
      ring0: number
      edge0: number
      start0: Position
      end0: Position
      frac0: number
      ring1: number
      edge1: number
      start1: Position
      end1: Position
      frac1: number
      unique: boolean
    }) => {
      return [
        isect,
        ring0,
        edge0,
        start0,
        end0,
        frac0,
        ring1,
        edge1,
        start1,
        end1,
        frac1,
        unique
      ]
    }
  })
  const numSelfIsect = selfIsectsData.length
  logger('Computing self-intersections')

  // If no self-intersections are found, the input rings are the output rings. Hence, we must only compute their winding numbers, net winding numbers and (since ohers rings could lie outside the first ring) parents.
  if (numSelfIsect == 0) {
    const outputFeatureArray = []
    for (let i = 0; i < numRings; i++) {
      outputFeatureArray.push(
        polygon([feature.geometry.coordinates[i]], {
          parent: -1,
          winding: windingOfRing(feature.geometry.coordinates[i])
        })
      )
    }
    const output = featureCollection(outputFeatureArray)
    determineParents(output)
    setNetWinding(output)
    logger(
      'No self-intersections found. Input rings are output rings. Computed winding numbers, net winding numbers and parents'
    )
    logger('Finishing without self-intersections')
    return output
  }

  // If self-intersections are found, we will compute the output rings with the help of two intermediate variables
  // First, we build the pseudo vertex list and intersection list
  // The Pseudo vertex list is an array with for each ring an array with for each edge an array containing the pseudo-vertices (as made by their constructor) that have this ring and edge as ringAndEdgeIn, sorted for each edge by their fractional distance on this edge. It's length hence equals numRings.
  const pseudoVtxListByRingAndEdge: PseudoVtx[][][] = []
  // The intersection list is an array containing intersections (as made by their constructor). First all numvertices ring-vertex-intersections, then all self-intersections (intra- and inter-ring). The order of the latter is not important but is permanent once given.
  const isectList: Isect[] = []
  // Adding ring-pseudo-vertices to pseudoVtxListByRingAndEdge and ring-vertex-intersections to isectList
  for (let i = 0; i < numRings; i++) {
    pseudoVtxListByRingAndEdge.push([])
    for (let j = 0; j < feature.geometry.coordinates[i].length - 1; j++) {
      // Each edge will feature one ring-pseudo-vertex in its array, on the last position. i.e. edge j features the ring-pseudo-vertex of the ring vertex j+1, which has ringAndEdgeIn = [i,j], on the last position.
      pseudoVtxListByRingAndEdge[i].push([
        new PseudoVtx(
          feature.geometry.coordinates[i][
            mod(j + 1, feature.geometry.coordinates[i].length - 1)
          ],
          1,
          [i, j],
          [i, mod(j + 1, feature.geometry.coordinates[i].length - 1)]
        )
      ])
      // The first numvertices elements in isectList correspond to the ring-vertex-intersections
      isectList.push(
        new Isect(
          feature.geometry.coordinates[i][j],
          [i, mod(j - 1, feature.geometry.coordinates[i].length - 1)],
          [i, j],
          false,
          true
        )
      )
    }
  }
  // Adding intersection-pseudo-vertices to pseudoVtxListByRingAndEdge and self-intersections to isectList
  for (let i = 0; i < numSelfIsect; i++) {
    // Adding intersection-pseudo-vertices made using selfIsectsData to pseudoVtxListByRingAndEdge's array corresponding to the incomming ring and edge
    pseudoVtxListByRingAndEdge[selfIsectsData[i][1]][selfIsectsData[i][2]].push(
      new PseudoVtx(
        selfIsectsData[i][0],
        selfIsectsData[i][5],
        [selfIsectsData[i][1], selfIsectsData[i][2]],
        [selfIsectsData[i][6], selfIsectsData[i][7]]
      )
    )
    // selfIsectsData contains double mentions of each intersection, but we only want to add them once to isectList
    if (selfIsectsData[i][11])
      isectList.push(
        new Isect(
          selfIsectsData[i][0],
          [selfIsectsData[i][1], selfIsectsData[i][2]],
          [selfIsectsData[i][6], selfIsectsData[i][7]],
          true,
          true
        )
      )
  }
  const numIsect = isectList.length
  // Sort edge arrays of pseudoVtxListByRingAndEdge by the fractional distance 'param'
  for (let i = 0; i < pseudoVtxListByRingAndEdge.length; i++) {
    for (let j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++) {
      pseudoVtxListByRingAndEdge[i][j].sort(function (a, b) {
        return a.param < b.param ? -1 : 1
      })
    }
  }
  logger('Setting up pseudoVtxListByRingAndEdge and isectList')

  // Make a spatial index of intersections, in preperation for the following two steps
  const allIsectsAsIsectRbushTreeItem = []
  for (let i = 0; i < numIsect; i++) {
    allIsectsAsIsectRbushTreeItem.push({
      minX: isectList[i].coord[0],
      minY: isectList[i].coord[1],
      maxX: isectList[i].coord[0],
      maxY: isectList[i].coord[1],
      index: i
    }) // could pass isect: isectList[i], but not necessary
  }
  const isectRbushTree = new RBush<RBushIsectItem>()
  isectRbushTree.load(allIsectsAsIsectRbushTreeItem)

  // Now we will teach each intersection in isectList which is the next intersection along both it's [ring, edge]'s, in two steps.
  // First, we find the next intersection for each pseudo-vertex in pseudoVtxListByRingAndEdge:
  // For each pseudovertex in pseudoVtxListByRingAndEdge (3 loops) look at the next pseudovertex on that edge and find the corresponding intersection by comparing coordinates
  for (let i = 0; i < pseudoVtxListByRingAndEdge.length; i++) {
    for (let j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++) {
      for (let k = 0; k < pseudoVtxListByRingAndEdge[i][j].length; k++) {
        let coordToFind
        if (k == pseudoVtxListByRingAndEdge[i][j].length - 1) {
          // If it's the last pseudoVertex on that edge, then the next pseudoVertex is the first one on the next edge of that ring.
          coordToFind =
            pseudoVtxListByRingAndEdge[i][
              mod(j + 1, feature.geometry.coordinates[i].length - 1)
            ][0].coord
        } else {
          coordToFind = pseudoVtxListByRingAndEdge[i][j][k + 1].coord
        }
        const IsectRbushTreeItemFound = isectRbushTree.search({
          minX: coordToFind[0],
          minY: coordToFind[1],
          maxX: coordToFind[0],
          maxY: coordToFind[1]
        })[0] // We can take [0] of the result, because there is only one isect correponding to a pseudo-vertex
        pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn =
          IsectRbushTreeItemFound.index
      }
    }
  }
  logger('Computing nextIsect for pseudoVtxListByRingAndEdge')

  // Second, we port this knowledge of the next intersection over to the intersections in isectList, by finding the intersection corresponding to each pseudo-vertex and copying the pseudo-vertex' knownledge of the next-intersection over to the intersection
  for (let i = 0; i < pseudoVtxListByRingAndEdge.length; i++) {
    for (let j = 0; j < pseudoVtxListByRingAndEdge[i].length; j++) {
      for (let k = 0; k < pseudoVtxListByRingAndEdge[i][j].length; k++) {
        const coordToFind = pseudoVtxListByRingAndEdge[i][j][k].coord
        const IsectRbushTreeItemFound = isectRbushTree.search({
          minX: coordToFind[0],
          minY: coordToFind[1],
          maxX: coordToFind[0],
          maxY: coordToFind[1]
        })[0] // We can take [0] of the result, because there is only one isect correponding to a pseudo-vertex
        const l = IsectRbushTreeItemFound.index
        if (l < numvertices) {
          // Special treatment at ring-vertices: we correct the misnaming that happened in the previous block, since ringAndEdgeOut = ringAndEdge2 for ring vertices.
          isectList[l].nxtIsectAlongRingAndEdge2 =
            pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn
        } else {
          // Port the knowledge of the next intersection from the pseudo-vertices to the intersections, depending on how the edges are labeled in the pseudo-vertex and intersection.
          if (
            equalArrays(
              isectList[l].ringAndEdge1,
              pseudoVtxListByRingAndEdge[i][j][k].ringAndEdgeIn
            )
          ) {
            isectList[l].nxtIsectAlongRingAndEdge1 =
              pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn
          } else {
            isectList[l].nxtIsectAlongRingAndEdge2 =
              pseudoVtxListByRingAndEdge[i][j][k].nxtIsectAlongEdgeIn
          }
        }
      }
    }
  }
  // This explains why, eventhough when we will walk away from an intersection, we will walk way from the corresponding pseudo-vertex along edgeOut, pseudo-vertices have the property 'nxtIsectAlongEdgeIn' in stead of some propery 'nxtPseudoVtxAlongEdgeOut'. This is because this property (which is easy to find out) is used in the above for nxtIsectAlongRingAndEdge1 and nxtIsectAlongRingAndEdge2!
  logger('Porting nextIsect to isectList')

  // Before we start walking over the intersections to build the output rings, we prepare a queue that stores information on intersections we still have to deal with, and put at least one intersection in it.
  // This queue will contain information on intersections where we can start walking from once the current walk is finished, and its parent output ring (the smallest output ring it lies within, -1 if no parent or parent unknown yet) and its winding number (which we can already determine).
  const queue: QueueItem[] = []
  // For each output ring, add the ring-vertex-intersection with the smalles x-value (i.e. the left-most) as a start intersection. By choosing such an extremal intersections, we are sure to start at an intersection that is a convex vertex of its output ring. By adding them all to the queue, we are sure that no rings will be forgotten. If due to ring-intersections such an intersection will be encountered while walking, it will be removed from the queue.
  let i = 0
  for (let j = 0; j < numRings; j++) {
    let leftIsect = i
    for (let k = 0; k < feature.geometry.coordinates[j].length - 1; k++) {
      if (isectList[i].coord[0] < isectList[leftIsect].coord[0]) {
        leftIsect = i
      }
      i++
    }
    // Compute winding at this left-most ring-vertex-intersection. We thus this by using our knowledge that this extremal vertex must be a convex vertex.
    // We first find the intersection before and after it, and then use them to determine the winding number of the corresponding output ring, since we know that an extremal vertex of a simple, non-self-intersecting ring is always convex, so the only reason it would not be is because the winding number we use to compute it is wrong
    const isectAfterLeftIsect = isectList[leftIsect].nxtIsectAlongRingAndEdge2
    if (isectAfterLeftIsect == undefined) {
      throw new Error('Next intersection not defined')
    }
    let isectBeforeLeftIsect = 0
    for (let k = 0; k < isectList.length; k++) {
      if (
        isectList[k].nxtIsectAlongRingAndEdge1 == leftIsect ||
        isectList[k].nxtIsectAlongRingAndEdge2 == leftIsect
      ) {
        isectBeforeLeftIsect = k
        break
      }
    }
    const windingAtIsect = isConvex(
      [
        isectList[isectBeforeLeftIsect].coord,
        isectList[leftIsect].coord,
        isectList[isectAfterLeftIsect].coord
      ],
      true
    )
      ? 1
      : -1

    queue.push({ isect: leftIsect, parent: -1, winding: windingAtIsect })
  }
  // Sort the queue by the same criterion used to find the leftIsect: the left-most leftIsect must be last in the queue, such that it will be popped first, such that we will work from out to in regarding input rings. This assumtion is used when predicting the winding number and parent of a new queue member.
  queue.sort(function (a, b) {
    return isectList[a.isect].coord > isectList[b.isect].coord ? -1 : 1
  })
  logger('Initial state of the queue: ' + JSON.stringify(queue))
  logger('Setting up queue')

  // Initialise output
  const outputFeatureArray = []

  // While the queue is not empty, take the last object (i.e. its intersection) out and start making an output ring by walking in the direction that has not been walked away over yet.
  while (queue.length > 0) {
    // Get the last object out of the queue
    const popped = queue.pop()!
    const startIsect = popped.isect
    const currentOutputRingParent = popped.parent
    const currentOutputRingWinding = popped.winding
    // Make new output ring and add vertex from starting intersection
    const currentOutputRing: number = outputFeatureArray.length
    const currentOutputRingCoords = [isectList[startIsect].coord]
    logger(
      '# Starting output ring number ' +
        outputFeatureArray.length +
        ' with winding ' +
        currentOutputRingWinding +
        ' from intersection ' +
        startIsect
    )
    if (startIsect < numvertices) {
      logger(
        'This is a ring-vertex-intersections, which means this output ring does not touch existing output rings'
      )
    }
    // Set up the variables used while walking over intersections: 'currentIsect', 'nxtIsect' and 'walkingRingAndEdge'
    let currentIsect = startIsect
    let walkingRingAndEdge
    let nxtIsect: number
    if (isectList[startIsect].ringAndEdge1Walkable) {
      walkingRingAndEdge = isectList[startIsect].ringAndEdge1
      if (isectList[startIsect].nxtIsectAlongRingAndEdge1 != undefined) {
        nxtIsect = isectList[startIsect].nxtIsectAlongRingAndEdge1
      } else {
        throw new Error('Next intersection not defined')
      }
    } else {
      walkingRingAndEdge = isectList[startIsect].ringAndEdge2
      if (isectList[startIsect].nxtIsectAlongRingAndEdge2 != undefined) {
        nxtIsect = isectList[startIsect].nxtIsectAlongRingAndEdge2
      } else {
        throw new Error('Next intersection not defined')
      }
    }
    // While we have not arrived back at the same intersection, keep walking
    while (
      !equalArrays(isectList[startIsect].coord, isectList[nxtIsect].coord)
    ) {
      logger(
        'Walking from intersection ' +
          currentIsect +
          ' to ' +
          nxtIsect +
          ' over ring ' +
          walkingRingAndEdge[0] +
          ' and edge ' +
          walkingRingAndEdge[1]
      )
      currentOutputRingCoords.push(isectList[nxtIsect].coord)
      logger('Adding intersection ' + nxtIsect + ' to current output ring')
      // If the next intersection is queued, we can remove it, because we will go there now.
      let nxtIsectInQueue
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].isect == nxtIsect) {
          nxtIsectInQueue = i
          break
        }
      }
      if (nxtIsectInQueue != undefined) {
        logger('Removing intersection ' + nxtIsect + ' from queue')
        queue.splice(nxtIsectInQueue, 1)
      }
      // Arriving at this new intersection, we know which will be our next walking ring and edge (if we came from 1 we will walk away from 2 and vice versa),
      // So we can set it as our new walking ring and intersection and remember that we (will) have walked over it
      // If we have never walked away from this new intersection along the other ring and edge then we will soon do, add the intersection (and the parent wand winding number) to the queue
      // (We can predict the winding number and parent as follows: if the edge is convex, the other output ring started from there will have the alternate winding and lie outside of the current one, and thus have the same parent ring as the current ring. Otherwise, it will have the same winding number and lie inside of the current ring. We are, however, only sure of this of an output ring started from there does not enclose the current ring. This is why the initial queue's intersections must be sorted such that outer ones come out first.)
      // We then update the other two walking variables.
      if (equalArrays(walkingRingAndEdge, isectList[nxtIsect].ringAndEdge1)) {
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge2
        isectList[nxtIsect].ringAndEdge2Walkable = false
        if (isectList[nxtIsect].ringAndEdge1Walkable) {
          logger('Adding intersection ' + nxtIsect + ' to queue')
          let pushing: QueueItem
          const nxtIsectAlongRingAndEdge2 =
            isectList[nxtIsect].nxtIsectAlongRingAndEdge2
          if (nxtIsectAlongRingAndEdge2 == undefined) {
            throw new Error('Next intersection not defined')
          }
          if (
            isConvex(
              [
                isectList[currentIsect].coord,
                isectList[nxtIsect].coord,
                isectList[nxtIsectAlongRingAndEdge2].coord
              ],
              currentOutputRingWinding == 1
            )
          ) {
            pushing = {
              isect: nxtIsect,
              parent: currentOutputRingParent,
              winding: -currentOutputRingWinding
            }
          } else {
            pushing = {
              isect: nxtIsect,
              parent: currentOutputRing,
              winding: currentOutputRingWinding
            }
          }
          queue.push(pushing)
        }
        currentIsect = nxtIsect
        const nextIsectCandidate = isectList[nxtIsect].nxtIsectAlongRingAndEdge2
        if (nextIsectCandidate != undefined) {
          nxtIsect = nextIsectCandidate
        } else {
          throw new Error('Next intersection not defined')
        }
      } else {
        walkingRingAndEdge = isectList[nxtIsect].ringAndEdge1
        isectList[nxtIsect].ringAndEdge1Walkable = false
        if (isectList[nxtIsect].ringAndEdge2Walkable) {
          logger('Adding intersection ' + nxtIsect + ' to queue')
          let pushing: QueueItem
          const nxtIsectAlongRingAndEdge1 =
            isectList[nxtIsect].nxtIsectAlongRingAndEdge1
          if (nxtIsectAlongRingAndEdge1 == undefined) {
            throw new Error('Next intersection not defined')
          }
          if (
            isConvex(
              [
                isectList[currentIsect].coord,
                isectList[nxtIsect].coord,
                isectList[nxtIsectAlongRingAndEdge1].coord
              ],
              currentOutputRingWinding == 1
            )
          ) {
            pushing = {
              isect: nxtIsect,
              parent: currentOutputRingParent,
              winding: -currentOutputRingWinding
            }
          } else {
            pushing = {
              isect: nxtIsect,
              parent: currentOutputRing,
              winding: currentOutputRingWinding
            }
          }
          queue.push(pushing)
        }
        currentIsect = nxtIsect
        const nextIsectCandidate = isectList[nxtIsect].nxtIsectAlongRingAndEdge1
        if (nextIsectCandidate != undefined) {
          nxtIsect = nextIsectCandidate
        } else {
          throw new Error('Next intersection not defined')
        }
      }
      logger('Current state of the queue: ' + JSON.stringify(queue))
    }
    logger(
      'Walking from intersection ' +
        currentIsect +
        ' to ' +
        nxtIsect +
        ' over ring ' +
        walkingRingAndEdge[0] +
        ' and edge ' +
        walkingRingAndEdge[1] +
        ' and closing ring'
    )
    // Close output ring
    currentOutputRingCoords.push(isectList[nxtIsect].coord)
    // Push output ring to output
    outputFeatureArray.push(
      polygon([currentOutputRingCoords], {
        index: currentOutputRing,
        parent: currentOutputRingParent,
        winding: currentOutputRingWinding,
        netWinding: undefined
      })
    )
  }

  const output = featureCollection(outputFeatureArray)
  logger('Walking')

  determineParents(output)
  logger('Determining parents')

  setNetWinding(output)
  logger('Setting winding number')

  logger('# Total of ' + output.features.length + ' rings')

  return output
}

/**
 * (Ring- or intersection-) Pseudo-vertices.
 *
 * @export
 * @class PseudoVtx
 * @typedef {PseudoVtx}
 */
export class PseudoVtx {
  coord: Position
  param: number
  ringAndEdgeIn: [number, number]
  ringAndEdgeOut: [number, number]
  nxtIsectAlongEdgeIn?: number

  /**
   * Creates an instance of PseudoVtx.
   *
   * @constructor
   * @param {Position} coord [x,y] of this pseudo-vertex
   * @param {number} param fractional distance of this intersection on incomming edge
   * @param {[number, number]} ringAndEdgeIn [ring index, edge index] of incomming edge
   * @param {[number, number]} ringAndEdgeOut [ring index, edge index] of outgoing edge
   */
  constructor(
    coord: Position,
    param: number,
    ringAndEdgeIn: [number, number],
    ringAndEdgeOut: [number, number]
  ) {
    this.coord = coord
    this.param = param
    this.ringAndEdgeIn = ringAndEdgeIn
    this.ringAndEdgeOut = ringAndEdgeOut
  }
}

/**
 * Intersection.
 *
 * There are two intersection-pseudo-vertices per self-intersection and one ring-pseudo-vertex per ring-vertex-intersection. Their labels 1 and 2 are not assigned a particular meaning but are permanent once given.
 *
 * @export
 * @class Intersection
 * @typedef {Isect}
 */
export class Isect {
  coord: Position
  ringAndEdge1: [number, number]
  ringAndEdge2: [number, number]
  ringAndEdge1Walkable: boolean
  ringAndEdge2Walkable: boolean
  nxtIsectAlongRingAndEdge1?: number
  nxtIsectAlongRingAndEdge2?: number

  constructor(
    coord: Position,
    ringAndEdge1: [number, number],
    ringAndEdge2: [number, number],
    ringAndEdge1Walkable: boolean,
    ringAndEdge2Walkable: boolean
  ) {
    this.coord = coord
    this.ringAndEdge1 = ringAndEdge1
    this.ringAndEdge2 = ringAndEdge2
    this.ringAndEdge1Walkable = ringAndEdge1Walkable
    this.ringAndEdge2Walkable = ringAndEdge2Walkable
  }
}

// Function to determine if three consecutive points of a simple, non-self-intersecting ring make up a convex vertex, assuming the ring is right- or lefthanded
function isConvex(pts: Position[], righthanded: boolean): boolean {
  if (typeof righthanded === 'undefined') righthanded = true
  if (pts.length != 3)
    throw new Error('This function requires an array of three points [x,y]')
  const d =
    (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) -
    (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
  return d >= 0 == righthanded
}

// Function to compute winding of simple, non-self-intersecting ring
function windingOfRing(ring: Position[]): number {
  // Compute the winding number based on the vertex with the smallest x-value, it precessor and successor. An extremal vertex of a simple, non-self-intersecting ring is always convex, so the only reason it is not is because the winding number we use to compute it is wrong
  let leftVtx = 0
  let winding: number
  for (let i = 0; i < ring.length - 1; i++) {
    if (ring[i][0] < ring[leftVtx][0]) leftVtx = i
  }
  if (
    isConvex(
      [
        ring[mod(leftVtx - 1, ring.length - 1)],
        ring[leftVtx],
        ring[mod(leftVtx + 1, ring.length - 1)]
      ],
      true
    )
  ) {
    winding = 1
  } else {
    winding = -1
  }
  return winding
}

// Fix Javascript modulo for negative number. From http://stackoverflow.com/questions/4467539/javascript-modulo-not-behaving
function mod(n: number, m: number) {
  return ((n % m) + m) % m
}

function determineParents(output: FeatureCollection<Polygon>) {
  const featuresWithoutParent = []
  for (let i = 0; i < output.features.length; i++) {
    logger(
      'Output ring ' +
        i +
        ' has parent ' +
        output.features[i].properties?.parent
    )
    if (output.features[i].properties?.parent == -1)
      featuresWithoutParent.push(i)
  }
  logger(
    'The following output ring(s) have no parent: ' + featuresWithoutParent
  )
  if (featuresWithoutParent.length > 1) {
    for (let i = 0; i < featuresWithoutParent.length; i++) {
      let parent = -1
      const parentArea = Infinity
      for (let j = 0; j < output.features.length; j++) {
        if (featuresWithoutParent[i] == j) continue
        if (
          booleanPointInPolygon(
            point(
              output.features[featuresWithoutParent[i]].geometry
                .coordinates[0][0]
            ),
            output.features[j],
            { ignoreBoundary: true }
          )
        ) {
          if (area(output.features[j]) < parentArea) {
            parent = j
            logger(
              'Ring ' +
                featuresWithoutParent[i] +
                ' lies inside output ring ' +
                j
            )
          }
        }
      }
      const properties = output.features[featuresWithoutParent[i]].properties
      if (properties) properties.parent = parent
      logger(
        'Ring ' + featuresWithoutParent[i] + ' is assigned parent ' + parent
      )
    }
  }
}

function setNetWinding(output: FeatureCollection<Polygon>) {
  for (let i = 0; i < output.features.length; i++) {
    const properties = output.features[i].properties
    if (properties?.parent == -1) {
      const netWinding = properties.winding
      properties.netWinding = netWinding
      setNetWindingOfChildren(output, i, netWinding)
    }
  }
}

function setNetWindingOfChildren(
  output: FeatureCollection<Polygon>,
  parent: number,
  parentNetWinding: number
) {
  for (let i = 0; i < output.features.length; i++) {
    const properties = output.features[i].properties
    if (properties?.parent == parent) {
      const netWinding = parentNetWinding + properties.winding
      properties.netWinding = netWinding
      setNetWindingOfChildren(output, i, netWinding)
    }
  }
}

function logger(message: string) {
  if (process.env.DEBUG === 'true') {
    console.log(message)
  }
}
