const bencode = require('bencode');
const config = require('./../config');
const crypto = require('crypto');
const dgram = require('dgram');
const Cache = require('./Cache');

const decodeNodes = (data) => {
	const nodes = [];

	for (let i = 0; i + 26 <= data.length; i += 26) {
		nodes.push({
			address: `${data[i + 20]}.${data[i + 21]}.${data[i + 22]}.${data[i + 23]}`,
			nid: data.slice(i, i + 20),
			port: data.readUInt16BE(i + 24),
		});
	}
	return nodes;
};
const encodeNodes = (nodes) =>
	Buffer.concat(
		nodes.map((node) => {
			const ipBuf = Buffer.from(node.address.split('.').map((octet) => parseInt(octet, 10)));
			const portBuf = Buffer.alloc(2);

			portBuf.writeUInt16BE(node.port, 0);
			return Buffer.concat([node.nid, ipBuf, portBuf]);
		}),
	);
const getNeighborID = (target, nid) => Buffer.concat([target.slice(0, 10), nid.slice(10)]);
const getRandomID = () =>
	crypto
		.createHash('sha1')
		.update(crypto.randomBytes(20))
		.digest();

const handleError = () => {
	// Do nothing
};

const safe = (fn) => (...params) => {
	try {
		const response = fn(...params);

		return response;
	} catch (error) {
		handleError(error);
	}

	return undefined;
};

const TID_LENGTH = 6;
const TOKEN_LENGTH = 2;

const getRandomTID = () => {
	const buf = Buffer.alloc(TID_LENGTH);
	for (let i = 0; i < TID_LENGTH; i += 1) {
		buf[i] = 0x30 + Math.floor(Math.random() * 0x4a);
	}
	return buf;
};
const K = 8;
const NODES_TABLE_MAX = 2000;
const INFOHASH_TABLE_MAX = 50000;
const SAMPLE_SIZE = 20;
const SAMPLE_REQUEST_INTERVAL = 60 * 1000;
const clientID = getRandomID();
const serverSocket = dgram.createSocket('udp4');
let nodes = [];
let onTorrent = (torrent) => console.log(torrent);
const cache = new Cache();
const nodesTable = new Map();
const infohashTable = new Map();
const bep52Nodes = new Map(); // "ip:port" -> node obj
let sampleResponseCounter = 0; // BEP-52 response log counter

const addInfohash = (infohash) => {
	if (!infohash || infohash.length !== 20) return;
	const key = infohash.toString('hex');
	if (infohashTable.has(key)) return;
	if (infohashTable.size >= INFOHASH_TABLE_MAX) {
		infohashTable.delete(infohashTable.keys().next().value);
	}
	infohashTable.set(key, { infohash, discovered: Date.now() });
};

const getSampleInfohashes = (target) => {
	const entries = Array.from(infohashTable.values());
	entries.sort((a, b) => {
		for (let i = 0; i < 20; i += 1) {
			const da = a.infohash[i] ^ target[i];
			const db = b.infohash[i] ^ target[i];
			if (da !== db) return da - db;
		}
		return 0;
	});
	return entries.slice(0, SAMPLE_SIZE).map((e) => e.infohash);
};

const addKnownNode = (node) => {
	if (!node.nid || node.nid.length !== 20 || node.nid.equals(clientID)) {
		return;
	}
	const key = node.nid.toString('hex');

	if (nodesTable.has(key)) {
		return;
	}
	if (nodesTable.size >= NODES_TABLE_MAX) {
		nodesTable.delete(nodesTable.keys().next().value);
	}
	nodesTable.set(key, { nid: node.nid, address: node.address, port: node.port });
};

const compareNodeDistance = (target, a, b) => {
	for (let i = 0; i < 20; i += 1) {
		const da = a.nid[i] ^ target[i];
		const db = b.nid[i] ^ target[i];

		if (da !== db) {
			return da - db;
		}
	}
	return 0;
};

const sendMessage = safe((message, rinfo) => {
	const buf = bencode.encode(message);

	serverSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
});

const onFindNodeResponse = safe((responseNodes) => {
	const decodedNodes = decodeNodes(responseNodes);

	decodedNodes.forEach((node) => {
		if (node.address !== '0.0.0.0' && node.nid !== clientID && node.port < 65536 && node.port > 0) {
			addKnownNode(node);
			cache.get(node.address, (err, value) => {
				if (!err && value) {
					if (err) {
						console.log(err);
					} else if (config.debug) {
						//							console.log(`node no expire`);
					}
				} else if (nodes.length <= 9000) {
					nodes.push(node);
					cache.set(node.address, 1);
					cache.expire(node.address, config.redis.expire);
				}
			});
		}
	});
});

const onGetPeersRequest = safe((msg, rinfo) => {
	const {
		a: { id: nid, info_hash: infohash },
		t: tid,
	} = msg;
	const token = infohash.slice(0, TOKEN_LENGTH);

	if (!tid || infohash.length !== 20 || nid.length !== 20) {
		throw new Error('No tid or nid or bad infohash');
	}

	sendMessage({ r: { id: getNeighborID(infohash, clientID), nodes: '', token }, t: tid, y: 'r' }, rinfo);
});

const onAnnouncePeerRequest = safe((msg, rinfo) => {
	const {
		a: { id: nid, info_hash: infohash, implied_port: impliedPort, port, token },
		t: tid,
	} = msg;
	const peerPort = impliedPort ? rinfo.port : port;

	if (!tid) {
		throw new Error('No tid');
	} else if (infohash.slice(0, TOKEN_LENGTH).toString() !== token.toString()) {
		throw new Error('invalid infohash length');
	} else if (!peerPort || peerPort >= 65536 || peerPort <= 0) {
		throw new Error('no port', peerPort);
	}

	sendMessage({ r: { id: getNeighborID(nid, clientID) }, t: tid, y: 'r' }, rinfo);
	// downloadTorrent({ address: rinfo.address, port }, infohash);
	addInfohash(infohash);
	onTorrent(infohash, { address: rinfo.address, port });
});

const onFindNodeRequest = safe((msg, rinfo) => {
	const {
		a: { id: nid, target },
		t: tid,
	} = msg;

	if (!tid || !nid || nid.length !== 20 || !target || target.length !== 20) {
		throw new Error('No tid or bad find_node args');
	}

	addKnownNode({ nid, address: rinfo.address, port: rinfo.port });

	const closest = Array.from(nodesTable.values())
		.sort((a, b) => compareNodeDistance(target, a, b))
		.slice(0, K);

	sendMessage(
		{ r: { id: getNeighborID(nid, clientID), nodes: encodeNodes(closest) }, t: tid, y: 'r' },
		rinfo,
	);
});

const onSampleInfohashesRequest = safe((msg, rinfo) => {
	const {
		a: { id: nid, target },
		t: tid,
	} = msg;

	if (!tid || !nid || nid.length !== 20 || !target || target.length !== 20) {
		throw new Error('No tid or bad sample_infohashes args');
	}

	addKnownNode({ nid, address: rinfo.address, port: rinfo.port });
	bep52Nodes.set(`${rinfo.address}:${rinfo.port}`, { nid, address: rinfo.address, port: rinfo.port });

	const samples = getSampleInfohashes(target);
	const compactSamples = Buffer.concat(samples);
	const closest = Array.from(nodesTable.values())
		.sort((a, b) => compareNodeDistance(target, a, b))
		.slice(0, K);

	const response = {
		r: {
			id: getNeighborID(target, clientID),
			samples: compactSamples,
			nodes: encodeNodes(closest),
			interval: 1800,
		},
		t: tid,
		y: 'r',
	};

	sendMessage(response, rinfo);

	if (config.debug) {
		sampleResponseCounter += 1;
		if (sampleResponseCounter % 20 === 0) {
			console.log(`[BEP-52] Responded to sample_infohashes ${sampleResponseCounter} times, last: ${rinfo.address}:${rinfo.port} with ${samples.length} samples`);
		}
	}
});

const parseCompactSamples = (data) => {
	if (!data || !Buffer.isBuffer(data)) return [];
	const samples = [];
	for (let i = 0; i + 20 <= data.length; i += 20) {
		samples.push(data.slice(i, i + 20));
	}
	return samples;
};

const onSampleInfohashesResponse = safe((msg, rinfo) => {
	if (!msg.r || !msg.r.samples) return;

	const samples = parseCompactSamples(msg.r.samples);
	let newCount = 0;

	samples.forEach((infohash) => {
		if (infohash && infohash.length === 20) {
			const key = infohash.toString('hex');
			if (!infohashTable.has(key)) {
				addInfohash(infohash);
				newCount += 1;
				onTorrent(infohash, { address: rinfo.address, port: rinfo.port });
			}
		}
	});

	if (config.debug && newCount > 0) {
		console.log(`[BEP-52] Got ${samples.length} samples (${newCount} new) from ${rinfo.address}:${rinfo.port}`);
	}
});

const sendSampleInfohashesRequest = (node) => {
	const t = getRandomTID();
	const target = getRandomID();

	sendMessage(
		{ a: { id: clientID, target }, q: 'sample_infohashes', t, y: 'q' },
		{ address: node.address, port: node.port },
	);
};

const onMessage = safe((message, rinfo) => {
	const msg = bencode.decode(message);
	const type = msg.y && Buffer.isBuffer(msg.y) ? msg.y.toString() : msg.y;
	const query = msg.q && Buffer.isBuffer(msg.q) ? msg.q.toString() : msg.q;

	if (type === 'q' && query === 'get_peers') {
		onGetPeersRequest(msg, rinfo);
	} else if (type === 'q' && query === 'announce_peer') {
		onAnnouncePeerRequest(msg, rinfo);
	} else if (type === 'q' && query === 'find_node') {
		onFindNodeRequest(msg, rinfo);
	} else if (type === 'q' && query === 'sample_infohashes') {
		onSampleInfohashesRequest(msg, rinfo);
	} else if (type === 'r' && msg.r.samples) {
		onSampleInfohashesResponse(msg, rinfo);
	} else if (type === 'r' && msg.r.nodes) {
		onFindNodeResponse(msg.r.nodes);
	} else if (type === 'q' && query === 'ping') {
		const tid = msg.t && Buffer.isBuffer(msg.t) ? msg.t.toString() : msg.t;
		const nid = msg.a && msg.a.id;
		if (tid && nid && nid.length === 20) {
			sendMessage({ r: { id: getNeighborID(nid, clientID) }, t: tid, y: 'r' }, rinfo);
		}
	} else if (type === 'q' && query === 'vote') {
		// Bittorrent extension protocol, not needed for scraper, silently ignore
	} else if (type === 'e') {
		const errCode = Array.isArray(msg.e) ? msg.e[0] : null;
		const key = `${rinfo.address}:${rinfo.port}`;
		if (errCode === 204 && bep52Nodes.has(key)) {
			// Node does not support sample_infohashes, remove from bep52Nodes
			bep52Nodes.delete(key);
			if (config.debug) {
				console.log(`[BEP-52] Removed ${key} from bep52Nodes (204 Method Unknown)`);
			}
		}
		if (config.debug) {
			console.log(`[BEP-52] error response from ${rinfo.address}:${rinfo.port} (code ${errCode}): ${JSON.stringify(msg)}`);
		}
	}
});

const sendFindNodeRequest = ({ address, port }, nid) => {
	const t = getRandomTID();
	const id = nid ? getNeighborID(nid, clientID) : clientID;

	sendMessage({ a: { id, target: getRandomID() }, q: 'find_node', t, y: 'q' }, { address, port });
};

const TABLE_PROBE_BATCH = 50;

const pickRandomFromTable = (count) => {
	const all = Array.from(nodesTable.values());

	if (all.length <= count) {
		return all;
	}
	const picked = [];
	const used = new Set();

	while (picked.length < count && used.size < all.length) {
		const idx = Math.floor(Math.random() * all.length);

		if (!used.has(idx)) {
			used.add(idx);
			picked.push(all[idx]);
		}
	}
	return picked;
};

const sendNodes = () => {
	let batch = nodes;
	let fromTable = false;

	if (batch.length === 0 && nodesTable.size > 0) {
		batch = pickRandomFromTable(TABLE_PROBE_BATCH);
		fromTable = true;
	}
	batch.forEach((node) => {
		sendFindNodeRequest(node, node.nid);
	});
	const nodesCount = batch.length;

	if (config.debug) {
		console.log(`start find node from ${nodesCount}  nodes${fromTable ? ' (from table)' : ''}`);
	}
	nodes = [];
	return fromTable;
};
const sendBootstrap = () => {
	config.bootstrapNodes.forEach((node) => {
		sendFindNodeRequest(node, null);
	});
	if (config.debug) {
		console.log(`bootstrap find_node sent to ${config.bootstrapNodes.length} nodes`);
	}
};

const BOOTSTRAP_INTERVAL = 5 * 60 * 1000;
let lastBootstrap = 0;

const sendBootstrapIfNeeded = () => {
	const now = Date.now();

	if (now - lastBootstrap >= BOOTSTRAP_INTERVAL) {
		sendBootstrap();
		lastBootstrap = now;
	}
};

let lastSampleRequest = 0;

const sendSampleRequestsIfNeeded = () => {
	const now = Date.now();

	if (now - lastSampleRequest >= SAMPLE_REQUEST_INTERVAL && (bep52Nodes.size > 0 || nodesTable.size > 0)) {
		const count = 10;
		// 优先从 bep52Nodes 中选取，并随机打乱
		const bep52List = Array.from(bep52Nodes.values());
		const shuffledBep52 = bep52List.sort(() => Math.random() - 0.5);
		let selected = shuffledBep52.slice(0, count);

		// 不足部分从路由表补充（排除已在 bep52Nodes 的节点）
		if (selected.length < count && nodesTable.size > 0) {
			const normalNodes = Array.from(nodesTable.values())
				.filter((n) => !bep52Nodes.has(`${n.address}:${n.port}`))
				.sort(() => Math.random() - 0.5);
			selected = selected.concat(normalNodes.slice(0, count - selected.length));
		}

		if (config.debug) {
			console.log(`[BEP-52] Sending sample_infohashes to ${selected.length} nodes (${bep52List.length} BEP-52 capable)`);
		}
		selected.forEach((node) => sendSampleInfohashesRequest(node));
		lastSampleRequest = now;

		if (config.debug) {
			console.log(`[BEP-52] Requests sent (infohashTable: ${infohashTable.size}, bep52Nodes: ${bep52Nodes.size})`);
		}
	}
};

const makeNeighbours = () => {
	try {
		const fromTable = sendNodes();

		sendBootstrapIfNeeded();
		try {
			sendSampleRequestsIfNeeded();
		} catch (err) {
			if (config.debug) {
				console.log('[sample] sendSampleRequestsIfNeeded error:', err);
			}
		}
		const sleepTime = fromTable ? 5 : Math.ceil(Math.random() * 3) + 1;

		setTimeout(() => makeNeighbours(), sleepTime * 1000);
	} catch (error) {
		if (config.debug) {
			console.log('[sample] makeNeighbours error:', error);
		}
		const sleepTime = Math.ceil(Math.random() * 3) + 1;

		setTimeout(() => makeNeighbours(), sleepTime * 1000);
	}
};

const start = () => {
	makeNeighbours();
};

const onListening = () => {
	console.log(`Crawler listening on ${config.crawler.address}:${config.crawler.port}`);

	start();
};

const crawler = (fn) => {
	serverSocket.bind(config.crawler.port, config.crawler.address);
	serverSocket.on('listening', onListening);
	serverSocket.on('message', onMessage);
	serverSocket.on('error', handleError);

	if (typeof fn === 'function') {
		onTorrent = fn;
	}
};

module.exports = crawler;
