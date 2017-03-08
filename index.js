require('dotenv').load()

let debug = require('debug')('index')
let local = require('./local')
let sync = require('./sync')
let qup = require('qup')
let zmq = require('./zmq')

function debugIfErr (err) {
  if (err) debug(err)
}

local(process.env.LEVELDB, (err, db) => {
  if (err) return debugIfErr(err)

  let syncQueue = qup((next) => sync(db, next), 1)

  zmq.on('hashblock', () => {
    syncQueue.push(null, debugIfErr)
  })

//   zmq.on('hashtx', (txId) => {
//     debug(`Seen ${txId} ${Date.now()}`)
//     local.see(txId)
//   })

  syncQueue.push(null, debugIfErr)
})
