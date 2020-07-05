const redis = require('redis');
const config = require('../config');

// //////////////////////////////////
// Cache
// //////////////////////////////////

function Cache() {
	this.redisClient = this.redisClient ? this.redisClient : redis.createClient(config.redis.port, config.redis.host);
}

Cache.prototype.keys = function keys(k, fn) {
	this.redisClient.keys(k, fn);
};

Cache.prototype.get = function get(k, fn) {
	this.redisClient.get(k, fn);
};

Cache.prototype.set = function set(k, v, fn) {
	this.redisClient.set(k, v, fn);
};

Cache.prototype.expire = function expire(k, interval) {
	this.redisClient.expire(k, interval);
};

Cache.prototype.del = function del(k, fn) {
	this.redisClient.del(k, fn);
};

/*
Cache.prototype.hset = function (k, f, v, fn) {
    if (this.redisClient.hset === undefined) {
        fn(Error(), null);
    } else {
        this.redisClient.hset(k, f, v, fn);
    }
};

Cache.prototype.hget = function (k, f, fn) {
    if (this.redisClient.hget === undefined) {
        fn(Error(), null);
    } else {
        this.redisClient.hget(k, f, fn);
    }
};
Cache.prototype.multiDel = function multiDel(k, fn) {
    const multi = this.redisClient.multi();

    _.each(k, (row) => {
        multi.del(row);
    });
    multi.exec();
};
*/

module.exports = Cache;
