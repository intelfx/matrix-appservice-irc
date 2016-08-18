/*eslint no-invalid-this: 0*/
"use strict"
var promiseutil = require("../promiseutil");
var Promise = require("bluebird");
var logging = require("../logging");
var log = logging.get("scheduler");

function ScheduledQueue (server) {
    this._queue = [];
    this._processing = null;
    this._server = server;
    // Start consuming
    this._consume();
}

ScheduledQueue.prototype._consume = Promise.coroutine(function*() {
    if (this._processing) {
        return;
    }
    this._processing = this._queue.shift();
    if (!this._processing) {
        // Nothing in the queue, try to consume after interval
        setTimeout(this._consume.bind(this), this._server.getReconnectIntervalMs());
        return;
    }
    try {
        yield Promise.delay(this._processing.addedDelay);
        let thing = this._procFn(this._processing);

        let result = yield thing;
        log.info(`Resolving scheduled promise for ${this._server.domain}`);
        this._processing.defer.resolve(result);
    }
    catch (err) {
        log.info(`Rejecting scheduled promise for ${this._server.domain} (${err.message})`);
        this._processing.defer.reject(err);
    }
    finally {
        this._processing = null;
        // Processing done, try to consume after interval
        setTimeout(this._consume.bind(this), this._server.getReconnectIntervalMs());
    }
});

ScheduledQueue.prototype._procFn = function (item) {
    return item.fn();
}

ScheduledQueue.prototype.enqueue = function (item) {
    this._queue.push(item);
}

ScheduledQueue.prototype.killAll = function() {
    for (var i = 0; i < this._queue.length; i++) {
        this._queue[i].reject();
    }
}

/**
 * An IRC connection scheduler. Enables ConnectionInstance to reconnect
 * in a way that queues reconnection requests and services the FIFO queue at a
 * rate determined by ircServer.getReconnectIntervalMs().
 */

var Scheduler = {
    _queueServers: [],
    _queues: {},
    _getQueue: _getQueue,
    _newQueue: _newQueue,
    reschedule: Promise.coroutine(function*(server, addedDelay, retryConnection) {
        var d = promiseutil.defer();

        var q = Scheduler._getQueue(server);

        q.enqueue({defer: d, fn: retryConnection, addedDelay: addedDelay});
        log.info(
            `Queued new scheduled promise for ${server.domain}` +
            (addedDelay > 0 ? ` with ${Math.round(addedDelay)}ms added delay`:'')
        );

        return d.promise;
    }),
    killAll: killAll
};

function _newQueue (server) {
    Scheduler._queues[server.domain] = new ScheduledQueue(server);
    Scheduler._queueServers.push(server.domain);

    return Scheduler._queues[server.domain];
}

function _getQueue (server) {
    let q = Scheduler._queues[server.domain];

    if (!q) {
        q = Scheduler._newQueue(server);
    }
    return q;
}


// Reject all queued promises
function killAll() {
    for (var i = 0; i < Scheduler._queueServers.length; i++) {
        var q = Scheduler._queues[Scheduler._queueServers[i]];
        q.killAll();
    }
}
module.exports = Scheduler;