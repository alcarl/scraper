const bencode = require('bencode');
const config = require('./../config');
const crypto = require('crypto');
const dgram = require('dgram');
const Cache = require('./Cache');

// 在文件顶部声明一个全局计数器
let unknownResponseCounter = 0;

const decodeNodes = (data) => {
	const nodes = [];

	for (let i = 0; i + 26 <= data.length; i += 26) {
		nodes.push({
			address: `${data[i + 20]}.${data[i + 21]}.${data[i + 22]}.${data[i + 23]}`,
			// ? 新增：直接截取这 4 字节的 IP 二进制，完全不需要消耗性能
			ipBuf: data.slice(i + 20, i + 24), 
			nid: data.slice(i, i + 20),
			port: data.readUInt16BE(i + 24),
		});
	}
	return nodes;
};

const encodeNodes = (nodes) =>
	Buffer.concat(
		nodes.map((node) => {
			// ✅ 核心优化：如果节点已有缓存的 ipBuf，直接用；否则（如 bootstrap 节点）才降级处理
			const ipBuf = node.ipBuf || Buffer.from(node.address.split('.').map((octet) => parseInt(octet, 10)));
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
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let tid = '';
	for (let i = 0; i < TID_LENGTH; i += 1) {
		tid += chars[Math.floor(Math.random() * chars.length)];
	}
	return tid;
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
// ✅ 新增：用于常驻存放绝对最新鲜的 20 个 infohash 缓存
let latestSamples = []; 

const addInfohash = (infohash) => {
	if (!infohash || infohash.length !== 20) return;
	const key = infohash.toString('hex');
	if (infohashTable.has(key)) return;

	// ✅ 核心优化：触发上限时，一次性批量淘汰最旧的 1000 个
	if (infohashTable.size >= INFOHASH_TABLE_MAX) {
		const iterator = infohashTable.keys();
		const BATCH_DELETE_COUNT = 1000;
		
		for (let i = 0; i < BATCH_DELETE_COUNT; i++) {
			const firstKey = iterator.next().value;
			if (!firstKey) break;
			infohashTable.delete(firstKey);
		}
	}

	infohashTable.set(key, { infohash, discovered: Date.now() });

	// 维护最新鲜的小队列
	latestSamples.push(infohash);
	if (latestSamples.length > SAMPLE_SIZE) {
		latestSamples.shift();
	}
};



const getSampleInfohashes = (target) => {
	// ✅ 极限优化：直接返回小队列副本，时间复杂度死死卡在 O(1)，单次执行只需几纳秒
	return [...latestSamples];
};



const addKnownNode = (node) => {
	if (!node.nid || node.nid.length !== 20 || node.nid.equals(clientID)) {
		return;
	}
	const key = node.nid.toString('hex');

	if (nodesTable.has(key)) {
		return;
	}

	// ✅ 核心优化：路由表触发上限时，一次性批量淘汰最旧的 100 个
	if (nodesTable.size >= NODES_TABLE_MAX) {
		const iterator = nodesTable.keys();
		const BATCH_DELETE_COUNT = 100;

		for (let i = 0; i < BATCH_DELETE_COUNT; i++) {
			const firstKey = iterator.next().value;
			if (!firstKey) break;
			nodesTable.delete(firstKey);
		}
	}

	nodesTable.set(key, { nid: node.nid, address: node.address, port: node.port, ipBuf: node.ipBuf });
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
	// 【核心修复】：如果发现 message.t 是字符串（通常是复用别人请求里的 t 导致的）
	// 必须强制使用 'binary' (latin1) 编码将其还原为原始字节 Buffer，绝不使用默认的 utf-8
	if (typeof message.t === 'string') {
		message.t = Buffer.from(message.t, 'binary');
	}

	const buf = bencode.encode(message);

	// Debug: 打印 sample_infohashes 请求的实际编码结果
	if (config.debug && message.q === 'sample_infohashes') {
		console.log(`[BEP-52] DEBUG send: t=${JSON.stringify(message.t)}, t_type=${typeof message.t}, buf_t_hex=${buf.toString('hex')}`);
	}

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
	} else if (type === 'r') {
		// 统一处理所有响应 (Response)
		if (msg.r && msg.r.samples) {
			onSampleInfohashesResponse(msg, rinfo);
		} else if (msg.r && msg.r.nodes) {
			onFindNodeResponse(msg.r.nodes);
		} else {
            // ❌ 其它未知的响应就让它在这里静静停下
            // ✅ 加上带频率限制的 Debug 日志
            if (config.debug) {
                unknownResponseCounter += 1;
                // 每隔 100 次打印一次，或者只在特定需要时开启，防止 I/O 阻塞
                if (unknownResponseCounter % 100 === 1) {
                    console.log(`[DHT] Skip unknown response from ${rinfo.address}:${rinfo.port}. Keys: ${Object.keys(msg.r || {})}`);
                }
            }
        }
    } else if (type === 'q' && query === 'ping') {
        // ❌ 废弃原有的 .toString()
        // ✅ 优化：直接保留对方发来的原始 Buffer 形式的 t，不做任何文本转换
        const tid = msg.t; 
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
