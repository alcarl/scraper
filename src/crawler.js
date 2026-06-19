const bencode = require('bencode');
const config = require('./../config');
const crypto = require('crypto');
const dgram = require('dgram');
const Cache = require('./Cache');

const NODE_ENTRY_LEN = { ipv4: 26, ipv6: 38 };
const IP_LEN = { ipv4: 4, ipv6: 16 };

const ipv6BufferToString = (buf) => {
	const parts = [];

	for (let i = 0; i < 8; i += 1) {
		parts.push(buf.readUInt16BE(i * 2).toString(16));
	}
	return parts.join(':');
};

const isZeroAddress = (node) => {
	if (node.family === 'ipv6') {
		return node.address === '0:0:0:0:0:0:0:0';
	}
	return node.address === '0.0.0.0';
};

const decodeNodes = (data, family) => {
	const nodes = [];
	const entryLen = NODE_ENTRY_LEN[family] || 26;
	const ipLen = IP_LEN[family] || 4;

	for (let i = 0; i + entryLen <= data.length; i += entryLen) {
		const ipBuf = data.slice(i + 20, i + 20 + ipLen);
		const address =
			family === 'ipv6'
				? ipv6BufferToString(ipBuf)
				: `${ipBuf[0]}.${ipBuf[1]}.${ipBuf[2]}.${ipBuf[3]}`;

		nodes.push({
			address,
			family,
			ipBuf,
			nid: data.slice(i, i + 20),
			port: data.readUInt16BE(i + 20 + ipLen),
		});
	}
	return nodes;
};
const encodeNodes = (nodes) =>
	Buffer.concat(
		nodes
			.filter((node) => node.ipBuf)
			.map((node) => {
				const portBuf = Buffer.alloc(2);

				portBuf.writeUInt16BE(node.port, 0);
				return Buffer.concat([node.nid, node.ipBuf, portBuf]);
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

const TID_LENGTH = 4;
const TOKEN_LENGTH = 2;
const K = 8;
const NODES_TABLE_MAX = 2000;
const clientID = getRandomID();
const sockets = {
	ipv4: dgram.createSocket('udp4'),
	ipv6: dgram.createSocket({ type: 'udp6', ipv6Only: true }),
};
let ipv6Enabled = false;
let nodes = [];
let onTorrent = (torrent) => console.log(torrent);
const cache = new Cache();
const nodesTable = new Map();

const familyOf = (rinfo) => (rinfo.family === 'IPv6' || rinfo.family === 'ipv6' ? 'ipv6' : 'ipv4');

const addKnownNode = (node) => {
	if (!node.nid || node.nid.length !== 20 || node.nid.equals(clientID)) {
		return;
	}
	const family = node.family || 'ipv4';
	const key = `${family}:${node.nid.toString('hex')}`;

	if (nodesTable.has(key)) {
		return;
	}
	if (nodesTable.size >= NODES_TABLE_MAX) {
		nodesTable.delete(nodesTable.keys().next().value);
	}
	nodesTable.set(key, {
		address: node.address,
		family,
		ipBuf: node.ipBuf || null,
		nid: node.nid,
		port: node.port,
	});
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
	const family = rinfo.family ? familyOf(rinfo) : 'ipv4';
	const sock = sockets[family];

	if (!sock || (family === 'ipv6' && !ipv6Enabled)) {
		return;
	}
	const buf = bencode.encode(message);

	sock.send(buf, 0, buf.length, rinfo.port, rinfo.address);
});

const onFindNodeResponse = safe((responseNodes, family) => {
	const decodedNodes = decodeNodes(responseNodes, family);

	decodedNodes.forEach((node) => {
		if (!isZeroAddress(node) && node.nid !== clientID && node.port < 65536 && node.port > 0) {
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

	addKnownNode({ nid, address: rinfo.address, port: rinfo.port, family: familyOf(rinfo) });

	const requesterFamily = familyOf(rinfo);
	const closest = Array.from(nodesTable.values())
		.filter((n) => n.family === requesterFamily && n.ipBuf)
		.sort((a, b) => compareNodeDistance(target, a, b))
		.slice(0, K);

	sendMessage(
		{ r: { id: getNeighborID(nid, clientID), nodes: encodeNodes(closest) }, t: tid, y: 'r' },
		rinfo,
	);
});

const onMessage = safe((message, rinfo) => {
	const msg = bencode.decode(message);
	const type = msg.y && Buffer.isBuffer(msg.y) ? msg.y.toString() : msg.y;
	const query = msg.q && Buffer.isBuffer(msg.q) ? msg.q.toString() : msg.q;

	if (type === 'r' && msg.r.nodes) {
		onFindNodeResponse(msg.r.nodes, familyOf(rinfo));
	} else if (type === 'q' && query === 'get_peers') {
		onGetPeersRequest(msg, rinfo);
	} else if (type === 'q' && query === 'announce_peer') {
		onAnnouncePeerRequest(msg, rinfo);
	} else if (type === 'q' && query === 'find_node') {
		onFindNodeRequest(msg, rinfo);
	}
});

const sendFindNodeRequest = (node, nid) => {
	const t = getRandomID().slice(0, TID_LENGTH);
	const id = nid ? getNeighborID(nid, clientID) : clientID;

	sendMessage(
		{ a: { id, target: getRandomID() }, q: 'find_node', t, y: 'q' },
		{ address: node.address, family: node.family || 'ipv4', port: node.port },
	);
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
		sendFindNodeRequest({ address: node.address, family: 'ipv4', port: node.port }, null);
		if (ipv6Enabled) {
			sendFindNodeRequest({ address: node.address, family: 'ipv6', port: node.port }, null);
		}
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

const makeNeighbours = () => {
	try {
		const fromTable = sendNodes();

		sendBootstrapIfNeeded();
		const sleepTime = fromTable ? 5 : Math.ceil(Math.random() * 3) + 1;

		setTimeout(() => makeNeighbours(), sleepTime * 1000);
	} catch (error) {
		if (config.debug) {
			console.log(error);
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
	sockets.ipv4.bind({ address: config.crawler.address, port: config.crawler.port });
	sockets.ipv4.on('listening', onListening);
	sockets.ipv4.on('message', onMessage);
	sockets.ipv4.on('error', handleError);

	if (config.crawler.enableIPv6 !== false) {
		sockets.ipv6.on('message', onMessage);
		sockets.ipv6.on('error', (err) => {
			if (config.debug) {
				console.log(`ipv6 socket error: ${err.message}`);
			}
		});
		sockets.ipv6.on('listening', () => {
			ipv6Enabled = true;
			console.log(`Crawler listening on [${config.crawler.address6 || '::'}]:${config.crawler.port6 || config.crawler.port}`);
		});
		try {
			sockets.ipv6.bind({ address: config.crawler.address6 || '::', port: config.crawler.port6 || config.crawler.port });
		} catch (err) {
			if (config.debug) {
				console.log(`ipv6 bind failed: ${err.message}`);
			}
		}
	}

	if (typeof fn === 'function') {
		onTorrent = fn;
	}
};

module.exports = crawler;
