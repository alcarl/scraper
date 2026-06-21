const dgram = require('dgram');
const crypto = require('crypto');

class TrackerScraper {
    constructor(addDHTNodeCallback) {
        this.client = dgram.createSocket('udp4');
        this.addDHTNodeCallback = addDHTNodeCallback; // 回调你的 addKnownNode 或 bep52Nodes.set
        
        this.client.on('message', (msg, rinfo) => this.handleResponse(msg, rinfo));
        this.client.on('error', () => {}); // 忽略部分 Tracker 的网络错误
    }

    // 向指定的 Tracker IP 和端口发起打捞
    scrape(trackerIp, trackerPort) {
        if (config.debug) {
            console.log(`[Tracker] 正在向中心发起握手: ${trackerIp}:${trackerPort}`);
        }
        // 1. 构造 Connection Request (BEP-15 握手)
        const connectionId = Buffer.from('0000041727101980', 'hex'); // 协议固定常量
        const action = 0; // 0 代表 connect
        const transactionId = crypto.randomBytes(4);

        const packet = Buffer.alloc(16);
        connectionId.copy(packet, 0);
        packet.writeInt32BE(action, 8);
        transactionId.copy(packet, 12);

        this.client.send(packet, 0, packet.length, trackerPort, trackerIp);
    }

    handleResponse(msg, rinfo) {
        if (msg.length < 8) return;
        const action = msg.readInt32BE(0);

        // 如果是 Connect 的回应
        if (action === 0) {
            const connectionId = msg.slice(8, 16);
            this.sendAnnounce(connectionId, rinfo.address, rinfo.port);
        }
        // 如果是 Announce 的回应 (包含我们要的 Peer 列表)
        else if (action === 1) {
            this.parsePeers(msg.slice(20)); // 前20字节是头信息，后面全是紧凑的 IP:Port
        }
    }

    // 2. 握手成功后，发送伪装的 Announce 请求索要 Peer 列表
    sendAnnounce(connectionId, ip, port) {
        const packet = Buffer.alloc(98);
        connectionId.copy(packet, 0);                 // Connection ID
        packet.writeInt32BE(1, 8);                    // Action = 1 (announce)
        crypto.randomBytes(4).copy(packet, 12);       // Transaction ID
        crypto.randomBytes(20).copy(packet, 16);      // Infohash (随机随一个，诱导 Tracker 返回同类活跃 Peer)
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
