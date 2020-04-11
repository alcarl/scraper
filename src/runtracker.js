const config = require('./../config');
const knex = require('knex')(config.db);
const tracker = require('./tracker');

tracker(knex);
