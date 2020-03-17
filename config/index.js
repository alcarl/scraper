const filters = require('./filters');
const formats = require('./formats');
const tags = require('./tags');

const config = {
	bootstrapNodes: [
		{ address: 'router.utorrent.com', port: 6881 },
		{ address: 'router.bitcomet.com', port: 6881 },
		{ address: 'dht.libtorrent.org', port: 25401 },
		{ address: 'dht.aelitis.com', port: 6881 },
		{ address: 'router.bittorrent.com', port: 6881 },
		{ address: 'dht.transmissionbt.com', port: 6881 },
	],
	crawler: {
		address: '0.0.0.0',
		port: 6881,
	},
	db: {
		/*
		 * SQLITE DB
		 * 	client: 'sqlite3',
		 * 	connection: {
		 * 		filename: './db.sqlite3',
		 * 	},
		 * 	useNullAsDefault: true,
		 */
		client: 'mysql',
		connection: {
			charset: 'utf8mb4',
			database: 'dht',
			host: '127.0.0.1',
			password: 'dht',
			user: 'dht',
		},
	},
	debug: true,
	elasticsearch: {
		host: '127.0.0.1',
		port: 9200,
	},
	filters,
	formats,
	search: {
		// Seconds between every bulk insert
		frequency: 30,
		// Amount of torrents to update in elasticsearch at once
		limit: 2000,
	},
	tags,
	tracker: {
		// Minutes before we should try and update a torrent again
		age: 1440,
		// Seconds between every scrape
		frequency: 1,
		host: ['udp://tracker.opentrackr.org:1337/announce'],
		limit: 75,
	},
};

module.exports = config;
