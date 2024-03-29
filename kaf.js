'use strict'
const fs = require('fs')
const path = require('path')
const http = require('http')
const url = require('url')

function startServer(opts_or_port, dbfolder_or_cb, cb) {
  let opts = opts_or_port
  if(typeof opts !== 'object') {
    opts = {
      port: opts_or_port,
      dbfolder: dbfolder_or_cb
    }
  } else {
    cb = dbfolder_or_cb
  }

  startSvr(opts, cb)
}

/*    way/
 * load existing data and start the server
 */
function startSvr(opts, cb) {
  loadExisting(opts.dbfolder, opts.ignore_errors, (err, data) => {
    if(err) cb(err)
    else serve(opts.port, { dbfolder: opts.dbfolder, data }, cb)
  })
}

let NO_LAST_NL = false

/*    way/
 * start a http server on the port serving and updating
 * the given data
 */
function serve(port, db, cb) {
  const server = http.createServer((req, res) => {
    if(req.method == "OPTIONS") return handleCORS(req, res)
    if(req.url.startsWith("/put/")) return put(req, res, db)
    if(req.url.startsWith("/get/")) return get(req, res, db)
    res.writeHead(404)
    res.end()
  })
  server.on("error", err => {
    cb(err)
    cb = null
  })
  server.listen(port, "127.0.0.1", err => {
    if(!err) {
      lg('started on port', db)
      cb && cb()
      cb = null
    }
  })
}

function addCORSHeaders(req, res) {
  let origin = req.headers["origin"]
  if(!origin) return
  res.setHeader("Access-Control-Allow-Origin", origin)
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Expose-Headers", "*")
}

/*    way/
 * allow cross-origin requests to access our data
 */
function handleCORS(req, res) {
  addCORSHeaders(req, res)
  res.end()
}

/*    way/
 * get the logfile and the message number and send a couple of messages
 * from that number onward back.
 */
function get(req, res, db) {
  let u = new URL(req.url, "http://localhost")
  let logfile = u.pathname.substring("/get/".length)
  let start = parseInt(u.searchParams.get("from"), 10)
  if(!start || isNaN(start)) {
    res.writeHead(400)
    res.end("invalid from="+start)
    return
  }
  let ret = []
  let log = db.data[logfile]
  if(log) {
    start -= 1
    ret = log.slice(start, start + 4096)
    res.setHeader("X-KAFJS-LASTMSGSENT", start + ret.length)
  }
  addCORSHeaders(req, res)
  res.end(JSON.stringify(ret))
}

/*    way/
 * get the logfile and the JSON object to put and append
 * it to the log file
 */
function put(req, res, db) {
  let u = new URL(req.url, "http://localhost")
  let logfile = u.pathname.substring("/put/".length)
  let body = []
  if(NO_LAST_NL) {
    body.push(Buffer.from("\n"))
    NO_LAST_NL = false
  }
  req.on("data", chunk => body.push(chunk))
  req.on("end", () => {
    if(body.length == 0) return resp_1(400, "Nothing to do")
    body.push(Buffer.from("\n"))
    body = Buffer.concat(body)
    try {
      let rec = JSON.parse(body.subarray(0, body.length-1))
      newRec(rec, body, logfile, db, err => {
        if(err) resp_1(500, err)
        else resp_1(200)
      })
    } catch(e) {
      resp_1(400, e)
    }
  })
  req.on("error", err => resp_1(500, err))

  let sent
  function resp_1(status, msg) {
    if(sent) return
    sent = true
    addCORSHeaders(req, res)
    res.writeHead(status)
    if(msg && typeof msg !== 'string') msg = "" + msg
    res.end(msg)
  }
}

/*    way/
 * append the new record to the appropriate log file and
 * add it to the in-memory cache
 */
function newRec(rec, body, name, db, cb) {
  if(!body) body = JSON.stringify(rec) + "\n"
  fs.appendFile(path.join(db.dbfolder, name), body, err => {
    if(err) return cb(err)
    if(db.data[name]) db.data[name].push(rec)
    else db.data[name] = [rec]
    cb()
  })
}

/*    way/
 * walk all the files (ignoring hidden files) and load each one -
 * ignoring parse errors (just logging them out)
 */
function loadExisting(dbfolder, ignore_errors, cb) {
  let DB = {}
  let ERRS = []
  fs.readdir(dbfolder, (err, files) => {
    if(err) cb(err)
    else {
      load_ndx_1(files, 0, () => {
        if(ERRS.length) cb({ code: "LOADFAILED", errors: ERRS }, DB)
        else cb(null, DB)
      })
    }
  })

  const NL=10
  const CR=13
  const SP=32
  const TAB=9

  function load_ndx_1(files, ndx, cb) {
    if(ndx >= files.length) return cb()
    let curr = files[ndx]
    if(isHidden(curr)) return load_ndx_1(files, ndx+1, cb)
    fs.readFile(path.join(dbfolder, curr), (err, data) => {
      let recs = []
      if(err) {
        ERRS.push({file: curr, err})
        lgErr(`error reading file:${curr}`, e, {
          data: DB,
          dbfolder,
        })
      } else {
        let s = 0
        let lnum = 0
        for(let i = 0;i < data.length;i++) {
          if(data[i] == NL || data[i] == CR) {
            lnum++
            add_rec_1(s, i, lnum)
            s = i
          }
        }
        lnum++
        if(add_rec_1(s, data.length, lnum)) NO_LAST_NL = true
        DB[curr] = recs
        load_ndx_1(files, ndx+1, cb)
      }

      function add_rec_1(s, e, lnum) {
        while(data[s] == NL || data[s] == CR
          || data[s] == SP || data[s] == TAB) {
          if(s == e) return false
          s++
        }
        if(s == e) return false
        let line = data.subarray(s, e)
        try {
          recs.push(JSON.parse(line))
        } catch(e) {
          ERRS.push({file: curr, line: lnum, err: e})
          lgErr(`error reading file:${curr}`, e, {
            data: DB,
            dbfolder,
          })
        }
        return true
      }
    })
  }
}

/*    understand/
 * We treat 'dot' files as hidden
 */
function isHidden(fname) { return !fname || fname[0] == "." }

/*    understand/
 * the internal log file used to manage our own info
 */
const LG = "_kafjs"

/*    way/
 * add an entry to our internal log file
 */
function lg(m, db) {
  let msg = { t: new Date().toISOString(), log: m }
  newRec(msg, null, LG, db, err => {
    if(err) console.error(err)
  })
}

/*    way/
 * record an error in our internal log file
 */
function lgErr(m, e, db) {
  let msg = {
    t: new Date().toISOString(),
    err: m,
  }
  if(e.stack) msg.stack = e.stack
  else msg.err += ":" + e.toString()
  newRec(msg, null, LG, db, err => {
    if(err) console.error(err)
  })
}

module.exports = {
  startServer,
}
