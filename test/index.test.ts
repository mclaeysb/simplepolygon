import { describe, test, expect } from 'vitest'
import { featureCollection } from '@turf/helpers'
import { featureEach } from '@turf/meta'
import simplepolygon from '../src'

import type { Polygon, Polygons } from '@turf/helpers'

// Import all test fixtures
import complex from './in/complex.json' with { type: 'json' }
import complexOut from './out/complex.json' with { type: 'json' }
import simple from './in/simple.json' with { type: 'json' }
import simpleOut from './out/simple.json' with { type: 'json' }
import withHole from './in/with-hole.json' with { type: 'json' }
import withHoleOut from './out/with-hole.json' with { type: 'json' }

describe('simplepolygon', () => {
  test('processes simple polygon correclty', async () => {
    const results = colorize(simplepolygon(simple as Polygon))
    expect(results).toEqual(simpleOut)
  })

  test('processes complex polygon correclty: complex feature must have more than 2 features', async () => {
    const results = colorize(simplepolygon(complex as Polygon))
    expect(results).toEqual(complexOut)
    expect(results.features.length).toBeGreaterThan(2)
  })

  test('processes polygon with hole correclty', async () => {
    const results = colorize(simplepolygon(withHole as Polygon))
    expect(results).toEqual(withHoleOut)
  })
})

function colorize(
  features: Polygons,
  colors: string[] = ['#F00', '#00F', '#0F0', '#F0F', '#FFF'],
  width: number = 6
): Polygons {
  const results: Polygon[] = []
  featureEach(features, (feature: Polygon, index: number) => {
    const color = colors[index % colors.length]
    feature.properties = Object.assign(feature.properties || {}, {
      stroke: color,
      fill: color,
      'stroke-width': width,
      'fill-opacity': 0.1
    })
    results.push(feature)
  })
  return featureCollection(results)
}
