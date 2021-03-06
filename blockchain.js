let debug = require('debug')('blockchain')
let parallel = require('run-parallel')
let types = require('./types')
let rpcUtil = require('./rpc')

function Blockchain (emitter, db, rpc) {
  this.emitter = emitter
  this.db = db
  this.rpc = rpc
}

Blockchain.prototype.connect = function (blockId, height, callback) {
  rpcUtil.block(this.rpc, blockId, (err, block) => {
    if (err) return callback(err)

    let atomic = this.db.atomic()
    let { height, transactions } = block

    transactions.forEach((tx) => {
      let { txId, txBuffer, ins, outs } = tx

      ins.forEach((input, vin) => {
        if (input.coinbase) return

        let { prevTxId, vout } = input
        atomic.put(types.spentIndex, { txId: prevTxId, vout }, { txId, vin })
        setTimeout(() => this.emitter.emit('spent', `${prevTxId}:${vout}`, txId))
      })

      outs.forEach(({ scId, value, vout }) => {
        atomic.put(types.scIndex, { scId, height, txId, vout }, null)
        atomic.put(types.txoIndex, { txId, vout }, { value })
        setTimeout(() => this.emitter.emit('script', scId, txId, txBuffer))
      })

      setTimeout(() => this.emitter.emit('transaction', txId, txBuffer, blockId))
      atomic.put(types.txIndex, { txId }, { height })
    })

    setTimeout(() => rpcUtil.header(this.rpc, blockId, (err, blockBuffer) => {
      if (err) return
      this.emitter.emit('block', blockId, blockBuffer, height)
    }))

    debug(`Putting ${blockId} @ ${height} - ${transactions.length} transactions`)
    atomic.put(types.tip, {}, { blockId, height })
    atomic.write((err) => {
      if (err) return callback(err)

      this.connect2ndOrder(blockId, block, callback)
    })
  })
}

function box (data) {
  if (data.length === 0) return { q1: 0, median: 0, q3: 0 }
  let quarter = (data.length / 4) | 0
  let midpoint = (data.length / 2) | 0

  return {
    q1: data[quarter],
    median: data[midpoint],
    q3: data[midpoint + quarter]
  }
}

Blockchain.prototype.connect2ndOrder = function (blockId, block, callback) {
  let feeRates = []
  let tasks = []
  let { height, transactions } = block

  transactions.forEach(({ ins, outs, vsize }) => {
    let inAccum = 0
    let outAccum = 0
    let subTasks = []
    let coinbase = false

    ins.forEach((input, vin) => {
      if (input.coinbase) {
        coinbase = true
        return
      }

      let { prevTxId, vout } = input
      subTasks.push((next) => {
        this.db.get(types.txoIndex, { txId: prevTxId, vout }, (err, output) => {
          if (err) return next(err)
          if (!output) return next(new Error(`Missing ${prevTxId}:${vout}`))

          inAccum += output.value
          next()
        })
      })
    })

    outs.forEach(({ value }, vout) => {
      outAccum += value
    })

    tasks.push((next) => {
      if (coinbase) {
        feeRates.push(0)
        return next()
      }

      parallel(subTasks, (err) => {
        if (err) return next(err)
        let fee = inAccum - outAccum
        let feeRate = Math.floor(fee / vsize)

        feeRates.push(feeRate)
        next()
      })
    })
  })

  debug(`Putting Order2 data ${blockId} @ ${height}`)
  parallel(tasks, (err) => {
    if (err) return callback(err)

    let atomic = this.db.atomic()
    feeRates = feeRates.sort((a, b) => a - b)

    atomic.put(types.feeIndex, { height }, { fees: box(feeRates), size: block.size })
    atomic.write(callback)
  })
}

Blockchain.prototype.disconnect = function (blockId, callback) {
  rpcUtil.block(this.rpc, blockId, (err, block) => {
    if (err) return callback(err)

    let atomic = this.db.atomic()
    let { height, transactions } = block

    transactions.forEach(({ txId, ins, outs }) => {
      ins.forEach((input) => {
        if (input.coinbase) return
        let { prevTxId, vout } = input

        atomic.del(types.spentIndex, { txId: prevTxId, vout })
      })

      outs.forEach(({ scId }, vout) => {
        atomic.del(types.scIndex, { scId, height, txId, vout })
        atomic.del(types.txoIndex, { txId, vout })
      })

      atomic.del(types.txIndex, { txId }, { height })
    })

    debug(`Deleting ${blockId} @ ${height} - ${transactions.length} transactions`)
    atomic.put(types.tip, {}, { blockId: block.previousblockhash, height })
    atomic.write(callback)
  })
}

// QUERIES
Blockchain.prototype.blockIdByTransactionId = function (txId, callback) {
  this.db.get(types.txIndex, { txId }, (err, row) => {
    if (err) return callback(err)
    if (!row) return callback()

    this.rpc('getblockhash', [row.height], callback)
  })
}

Blockchain.prototype.fees = function (n, callback) {
  this.db.get(types.tip, {}, (err, result) => {
    if (err) return callback(err)

    let maxHeight = result.height
    let fresult = []

    this.db.iterator(types.feeIndex, {
      gte: { height: maxHeight - n }
    }, ({ height }, { fees, size }) => {
      fresult.push({ height, fees, size })
    }, (err) => callback(err, fresult))
  })
}

let ZERO64 = '0000000000000000000000000000000000000000000000000000000000000000'
Blockchain.prototype.seenScriptId = function (scId, callback) {
  let result = false

  this.db.iterator(types.scIndex, {
    gte: { scId, height: 0, txId: ZERO64, vout: 0 },
    lt: { scId, height: 0xffffffff, txId: ZERO64, vout: 0 },
    limit: 1
  }, () => {
    result = true
  }, (err) => callback(err, result))
}

Blockchain.prototype.spentFromTxo = function (txo, callback) {
  this.db.get(types.spentIndex, txo, callback)
}

Blockchain.prototype.tip = function (callback) {
  this.db.get(types.tip, {}, (err, tip) => {
    callback(err, tip && tip.blockId)
  })
}

Blockchain.prototype.transactionIdsByScriptId = function (scId, height, callback) {
  this.txosByScriptId(scId, height, (err, txosMap) => {
    if (err) return callback(err)

    let taskMap = {}
    for (let txoKey in txosMap) {
      let txo = txosMap[txoKey]

      taskMap[txoKey] = (next) => this.spentFromTxo(txo, next)
    }

    parallel(taskMap, (err, spentMap) => {
      if (err) return callback(err)

      let txIds = {}

      for (let x in spentMap) {
        let spent = spentMap[x]
        if (!spent) continue

        txIds[spent.txId] = true
      }

      for (let x in txosMap) {
        let { txId } = txosMap[x]
        txIds[txId] = true
      }

      callback(null, txIds)
    })
  })
}

Blockchain.prototype.txosByScriptId = function (scId, height, callback) {
  let resultMap = {}

  this.db.iterator(types.scIndex, {
    gte: { scId, height, txId: ZERO64, vout: 0 },
    lt: { scId, height: 0xffffffff, txId: ZERO64, vout: 0 }
  }, ({ txId, vout, height }) => {
    resultMap[`${txId}:${vout}`] = { txId, vout, scId, height }
  }, (err) => callback(err, resultMap))
}

Blockchain.prototype.txoByTxo = function (txId, vout, callback) {
  this.db.get(types.txoIndex, { txId, vout }, callback)
}

module.exports = Blockchain
