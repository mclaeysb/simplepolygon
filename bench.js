const Benchmark = require('benchmark');
const path = require('path');
const fs = require('fs');
const load = require('load-json-file');
const simplepolygon = require('./');

const directory = path.join(__dirname, 'test', 'in') + path.sep;
const fixtures = fs.readdirSync(directory).map(filename => {
    return {
        filename,
        name: path.parse(filename).name,
        geojson: load.sync(directory + filename)
    };
});

/**
 * Benchmark Results
 *
 * complex x 5,311 ops/sec ±12.57% (69 runs sampled)
 * simple x 36,499 ops/sec ±1.75% (87 runs sampled)
 * with-hole x 44,355 ops/sec ±1.93% (88 runs sampled)
 */
const suite = new Benchmark.Suite('simplepolygon');
for (const {name, geojson} of fixtures) {
    suite.add(name, () => simplepolygon(geojson));
}

suite
    .on('cycle', e => console.log(String(e.target)))
    .on('complete', () => {})
    .run();