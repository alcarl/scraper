const config = require('./../config'); 
const dgram = require('dgram');
const crypto = require('crypto');

class TrackerScraper {
    constructor(addDHTNodeCallback) {
        this.client = dgram.createSocket('udp4');
        this.addDHTNodeCallback = addDHTNodeCallback; // 回调你的 addKnownNode 或 bep52Nodes.set
        // 💡 新增：建立一个内存中的轻量隐式事务队列
        // 专门用来映射: "4字节的随机事务ID" -> "它当时对应的 20字节 infohash"
        this.txMap = new Map();

        this.client.on('message', (msg, rinfo) => this.handleResponse(msg, rinfo));
        this.client.on('error', () => {}); // 忽略部分 Tracker 的网络错误
    }

    // 向指定的 Tracker IP 和端口发起打捞
    scrape(trackerIp, trackerPort, infohash) {
        if (config.debug) {
            console.log(`[Tracker] 正在向中心发起握手: ${trackerIp}:${trackerPort}`);
        }
        // 1. 构造 Connection Request (BEP-15 握手)
        const connectionId = Buffer.from('0000041727101980', 'hex'); // 协议固定常量
        const action = 0; // 0 代表 connect
        // 生成唯一的 4 字节事务 ID
        const transactionId = crypto.randomBytes(4);
        const txKey = transactionId.toString('hex');

        // ✅ 将这个种子临时存入事务字典中，跟这个 ID 死死绑定
        this.txMap.set(txKey, infohash);

        // 定时清理过期的事务，防止内存泄露
        setTimeout(() => this.txMap.delete(txKey), 15 * 1000);

        const packet = Buffer.alloc(16);
        connectionId.copy(packet, 0);
        packet.writeInt32BE(action, 8);
        transactionId.copy(packet, 12);
        // 💡 关键：把 infohash 挂在 Socket 对象的临时缓存里，或者直接作为属性（因为多进程/实例间是隔离的）
        // 为了简单防并发错乱，我们直接在发送请求前把当前要查询的 infohash 绑定一下
        this.currentTargetHash = infohash;
        this.client.send(packet, 0, packet.length, trackerPort, trackerIp);
    }

    handleResponse(msg, rinfo) {
        if (msg.length < 8) return;
        const action = msg.readInt32BE(0);
        // 提取对方回给我们的 4 字节 Transaction ID
        const transactionId = msg.slice(4, 8);
        const txKey = transactionId.toString('hex');

        // 如果是 Connect 的回应
        if (action === 0) {
            const connectionId = msg.slice(8, 16);
            // ✅ 从事务字典里把这个 ID 专属的那个 infohash 掏出来，传给第二阶段
            const matchedHash = this.txMap.get(txKey);
            this.sendAnnounce(connectionId, rinfo.address, rinfo.port, matchedHash, transactionId);
            
            this.txMap.delete(txKey); // 功成身退，立刻删除
        }
        // 如果是 Announce 的回应 (包含我们要的 Peer 列表)
        else if (action === 1) {
            this.parsePeers(msg.slice(20)); // 前20字节是头信息，后面全是紧凑的 IP:Port
        }
    }

    // 2. 握手成功后，发送伪装的 Announce 请求索要 Peer 列表
    sendAnnounce(connectionId, ip, port, matchedHash, transactionId) {
        const packet = Buffer.alloc(98);
        connectionId.copy(packet, 0);                 // Connection ID
        packet.writeInt32BE(1, 8);                    // Action = 1 (announce)
        // 保持 Transaction ID 一致
        transactionId.copy(packet, 12);       

        // ✅ 完美分流：每个并发请求使用的都是它自己对应的那个精准种子
        const targetHash = matchedHash || Buffer.from('cb84ccc10d1e2e15097a40becb39a835b57d0712', 'hex');
        targetHash.copy(packet, 16);

        crypto.randomBytes(20).copy(packet, 36);      // Peer ID
        Buffer.alloc(8).copy(packet, 56);             // Downloaded = 0
        Buffer.alloc(8).copy(packet, 64);             // Left = 0
        Buffer.alloc(8).copy(packet, 72);             // Uploaded = 0
        packet.writeInt32BE(0, 80);                   // Event = 0 (none)
        packet.writeInt32BE(0, 84);                   // IP = 0 (default)
        crypto.randomBytes(4).copy(packet, 88);       // Key
        packet.writeInt32BE(-1, 92);                  // Num_want = -1 (默认索要尽可能多的 Peer，通常是 50-200个)
        packet.writeUInt16BE(6881, 96);               // Port

        this.client.send(packet, 0, packet.length, port, ip);
    }

    // 3. 解析二进制紧凑 Peer 列表，并喂给你的 DHT 爬虫
    parsePeers(peersBuffer) {
        let peerCount = 0; // 新增一个计数器
        // 紧凑模式下，每 6 字节代表一个 Peer（4字节 IP + 2字节 Port）
        for (let i = 0; i + 6 <= peersBuffer.length; i += 6) {
            const ip = `${peersBuffer[i]}.${peersBuffer[i+1]}.${peersBuffer[i+2]}.${peersBuffer[i+3]}`;
            const port = peersBuffer.readUInt16BE(i + 4);

            if (port > 0 && port < 65536) {
                peerCount++; // 计数增加
                // 💡 核心注入：伪装一个 20 字节的虚拟随机 NID，把这个公网活 Peer 强制喂给你的主循环
                const virtualNid = crypto.randomBytes(20);
                
                this.addDHTNodeCallback({
                    nid: virtualNid,
                    address: ip,
                    port: port
                });
            }
        }

            // ✅ 打印打捞战果
        if (config.debug && peerCount > 0) {
            console.log(`[Tracker] 🎉 成功打捞！从该中心斩获了 ${peerCount} 个公网活 Peer IP`);
        }
    }
}

module.exports = TrackerScraper;
