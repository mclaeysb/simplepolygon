import { bench, describe } from 'vitest'
import simplepolygon from '../src/index.ts'

import type { Feature, Polygon } from 'geojson'

import complex from '../test/in/complex.json' with { type: 'json' }
import simple from '../test/in/simple.json' with { type: 'json' }
import withHole from '../test/in/with-hole.json' with { type: 'json' }

describe('simplepolygon benchmarks', () => {
  bench('simple', () => {
    simplepolygon(simple as Feature<Polygon>)
  })
  bench('complex', () => {
    simplepolygon(complex as Feature<Polygon>)
  })
  bench('withHole', () => {
    simplepolygon(withHole as Feature<Polygon>)
  })
})
