const config = require('./../config');
const crawler = require('./crawler');
const parser = require('./parser');
const tracker = require('./tracker');
const knex = require('knex')(config.db);

const getCount = async () => {
	// const [count] = await knex('torrents').count('infohash');
	const [count2] = await knex('torrents')
		.count('infohash')
		.whereNull('trackerUpdated');
	const [count3] = await knex('torrents')
		.count('searchUpdate')
		.where({ searchUpdate: false });

	// console.log(`Total Torrents: ${count['count(`infohash`)']}`);
	console.log(`Torrents without Tracker: ${count2['count(`infohash`)']}`);
	console.log(`Torrents not in Search: ${count3['count(`searchUpdate`)']}`);
	setTimeout(() => getCount(), 60000);
};

const addTorrent = async (infohash, rinfo) => {
	try {
		const records = await knex('torrents')
			.select('infohash')
			.where({ infohash: infohash.toString('hex') });

		if (records.length === 0) {
			parser(infohash, rinfo, knex);
		}
	} catch (error) {
		if (config.debug) {
			console.log(error);
		}
	}
};

crawler(addTorrent);
tracker(knex);
getCount();
