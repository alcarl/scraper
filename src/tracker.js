const Client = require('bittorrent-tracker');
const config = require('./../config');

const updateRecord = async (knex, record) => {
	if (config.debug) {
		console.log(`${record.infoHash} - ${record.complete}:${record.incomplete}`);
	}
	if (record.complete > 0 || record.incomplete > 0) {
		await knex('torrents')
			.update({
				leechers: record.incomplete,
				seeders: record.complete,
				trackerUpdated: new Date(),
			})
			.where({ infohash: record.infoHash });
	} else {
		// if leechers ==0 and seeders==0 then add tracker update interval
		await knex('torrents')
			.update({
				leechers: record.incomplete,
				seeders: record.complete,
				trackerUpdated: knex.raw('date_add(now(),interval (datediff(now(),created)) day)'),
			})
			.where({ infohash: record.infoHash });
	}
};

const scrape = async (knex, records) => {
	const options = {
		announce: config.tracker.host,
		infoHash: records.map(({ infohash }) => infohash),
	};

	try {
		const results = await new Promise((resolve, reject) => {
			Client.scrape(options, (error, data) => (error ? reject(error) : resolve(data)));
		});

		if (results.infoHash) {
			await updateRecord(knex, results);
		} else {
			const hashes = Object.keys(results);

			for (let i = 0; i < hashes.length; i += 1) {
				await updateRecord(knex, results[hashes[i]]); // eslint-disable-line no-await-in-loop
			}
		}
	} catch (error) {
		// Do nothing
	}
};

const getRecords = async (knex) => {
	const newRecords = await knex('torrents')
		.select('infohash')
		.whereNull('trackerUpdated')
		.limit(config.tracker.limit);
	const newLimit = config.tracker.limit - newRecords.length;
	const age = new Date(Date.now() - 1000 * 60 * config.tracker.age);
	const outdatedRecords = await knex('torrents')
		.select('infohash')
		.where('trackerUpdated', '<', age)
		.limit(newLimit);

	return [...newRecords, ...outdatedRecords];
};

const tracker = async (knex) => {
	const records = await getRecords(knex);

	if (records.length > 0) {
		try {
			await scrape(knex, records);
		} catch (error) {
			// Do nothing
		}
	}

	setTimeout(() => tracker(knex), config.tracker.frequency * 1000);
};

module.exports = tracker;