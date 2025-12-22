import { bench, describe } from 'vitest'
import simplepolygon from '../src'

import type { Polygon } from '@turf/helpers'

// Import all test fixtures
import complex from '../test/in/complex.json' with { type: 'json' }
import simple from '../test/in/simple.json' with { type: 'json' }
import withHole from '../test/in/with-hole.json' with { type: 'json' }

describe('simplepolygon benchmarks', () => {
  bench('simple', () => {
    simplepolygon(simple as Polygon)
  })
  bench('complex', () => {
    simplepolygon(complex as Polygon)
  })
  bench('withHole', () => {
    simplepolygon(withHole as Polygon)
  })
})
