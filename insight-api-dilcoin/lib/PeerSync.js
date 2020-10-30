'use strict';
var fs          = require('fs');
var bitcore     = require('darkcore');
var bitcoreUtil = bitcore.util;
var Sync        = require('./Sync');
var Peer        = bitcore.Peer;
var PeerManager = bitcore.PeerManager;
var config      = require('../config/config');
var networks    = bitcore.networks;
var sockets     = require('../app/controllers/socket.js');

var peerdb_fn   = 'peerdb.json';

function PeerSync(opts) {
  opts = opts|| {};
  this.shouldBroadcast = opts.shouldBroadcast;
  this.connected = false;
  this.interval = 5000;
  this.peerdb = undefined;
  this.allowReorgs = false;
  var pmConfig = {
    network: config.network
  };
  this.peerman = new PeerManager(pmConfig);
  this.load_peers();
  this.sync = new Sync(opts);
  this.verbose = opts.verbose || false;
}

PeerSync.prototype.log = function() {
  if (this.verbose) console.log(arguments);
};

PeerSync.prototype.load_peers = function() {
  this.peerdb = [{
    ipv4: config.bitcoind.p2pHost,
    port: config.bitcoind.p2pPort
  }];

  fs.writeFileSync(peerdb_fn, JSON.stringify(this.peerdb));
};

PeerSync.prototype.info = function() {
  return {
    connected: this.connected,
    host: this.peerdb[0].ipv4,
    port: this.peerdb[0].port
  };
};

PeerSync.prototype.handleInv = function(info) {
  var invs = info.message.invs;
  info.conn.sendGetData(invs);
};

PeerSync.prototype._broadcastAddr = function(txid, addrs) {
  if (addrs) {
    for(var ii in addrs){
      sockets.broadcastAddressTx(txid, ii);
    }
  }
};


PeerSync.prototype._handleTx = function(info, txType) {
  var self =this;
  var tx = this.sync.txDb.getStandardizedTx(info.message.tx);
  self.log('[p2p_sync] Handle tx: ' + tx.txid);
  tx.time = tx.time || Math.round(Date.now() / 1000);

  this.sync.storeTx(tx, function(err, relatedAddrs) {
    if (err) {
      self.log('[p2p_sync] Error in handle TX: ' + JSON.stringify(err));
    }
    else if (self.shouldBroadcast) {
      sockets.broadcastTx(tx, txType);
      self._broadcastAddr(tx.txid, relatedAddrs);
    }
  });
};

PeerSync.prototype.handleTx = function(info) {
  this._handleTx(info, 'tx');
}

PeerSync.prototype.handleIX = function(info) {
  this._handleTx(info, 'ix');
}

PeerSync.prototype.handleBlock = function(info) {
  var self = this;
  var block = info.message.block;
  var blockHash = bitcoreUtil.formatHashFull(block.calcHash());
  self.log('[p2p_sync] Handle block: ' + blockHash + ' (allowReorgs: ' + self.allowReorgs + ')');

  var tx_hashes = block.txs.map(function(tx) {
    return bitcoreUtil.formatHashFull(tx.hash);
  });

  self.sync.storeTipBlock({
    'hash': blockHash,
    'tx': tx_hashes,
    'previousblockhash': bitcoreUtil.formatHashFull(block.prev_hash),
  }, self.allowReorgs, function(err, height) {
    if (err && err.message.match(/NEED_SYNC/) && self.historicSync) {
      self.log('[p2p_sync] Orphan block received. Triggering sync');
      self.historicSync.start({forceRPC:1}, function(){
        self.log('[p2p_sync] Done resync.');
      });
    }
    else if (err) {
      self.log('[p2p_sync] Error in handle Block: ', err);
    }
    else {
      if (self.shouldBroadcast) {
        sockets.broadcastBlock(blockHash);
        // broadcasting address here is a bad idea. listening to new block
        // should be enoght
      }
    }
  });
};

PeerSync.prototype.handleConnected = function(data) {
  var peerman = data.pm;
  var peers_n = peerman.peers.length;
  this.log('[p2p_sync] Connected to ' + peers_n + ' peer' + (peers_n !== 1 ? 's' : ''));
};

PeerSync.prototype.checkStatus = function() {
  // Make sure we are connected
  if (!this.connected && this.timer) {
    this.run();
  }
};

PeerSync.prototype.run = function() {
  var self = this;

  if (this.timer) clearInterval(this.timer);

  this.peerdb.forEach(function(datum) {
    var peer = new Peer(datum.ipv4, datum.port);
    self.peerman.addPeer(peer);
  });

  this.peerman.on('connection', function(conn) {
    self.connected = true;
    conn.on('inv', self.handleInv.bind(self));
    conn.on('block', self.handleBlock.bind(self));
    conn.on('tx', self.handleTx.bind(self));
    conn.on('ix', self.handleIX.bind(self));
  });
  this.peerman.on('connect', self.handleConnected.bind(self));

  this.peerman.on('netDisconnected', function() {
    self.connected = false;
    if (!self.timer) self.timer = setInterval(self.checkStatus.bind(self), self.interval);
  });

  this.peerman.start();
};

PeerSync.prototype.close = function() {
  this.sync.close();
};


module.exports = require('soop')(PeerSync);