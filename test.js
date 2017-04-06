const test = require('tape');
const fs = require('fs');
const path = require('path');
const load = require('load-json-file');
const write = require('write-json-file');
const featureCollection = require('@turf/helpers').featureCollection;
const featureEach = require('@turf/meta').featureEach;
const simplepolygon = require('./');

const directories = {
    in: path.join(__dirname, 'test', 'in') + path.sep,
    out: path.join(__dirname, 'test', 'out') + path.sep
};

const fixtures = fs.readdirSync(directories.in).map(filename => {
    return {
        filename,
        name: path.parse(filename).name,
        geojson: load.sync(directories.in + filename)
    };
});

test('simplepolygon', t => {
    for (const {filename, name, geojson}  of fixtures) {
        const results = colorize(simplepolygon(geojson));
        results.features.push(geojson)

        if (process.env.REGEN) write.sync(directories.out + filename, results);
        t.deepEquals(results, load.sync(directories.out + filename), name);
    }
    t.end();
});

function colorize(features, color = '#F00', width = 6) {
    const results = [];
    featureEach(features, feature => {
        feature.properties = {
            stroke: color,
            fill: color,
            'stroke-width': width,
            'fill-opacity': 0.1
        };
        results.push(feature);
    });
    return featureCollection(results);
}