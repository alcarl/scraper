/* eslint-disable camelcase */
module.exports = {
	apps: [
		{
			exec_mode: 'cluster',
			instances: 3,
			max_memory_restart: '600M',
			name: 'scraper',
			script: 'scraper.js',
		},
		{
			name: 'loader',
			script: 'loader.js',
		},
		{
			name: 'tracker',
			script: 'tracker.js',
		},
	],
};
