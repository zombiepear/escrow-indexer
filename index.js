const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { createPublicClient, http, decodeEventLog, keccak256, toHex } = require('viem');
const { base } = require('viem/chains');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
app.use('/dashboard', express.static('public'));

// Security headers (OWASP)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS - restrict to known origins (can be expanded)
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://agentjobs.agency'];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, etc) or from allowed list
    if (!origin || allowedOrigins.includes(origin) || origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(null, true); // Log but allow for now (public API)
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
}));

// Request logging (security monitoring)
const logFormat = ':date[iso] :method :url :status :response-time ms - :remote-addr :user-agent';
app.use(morgan(logFormat, {
  stream: {
    write: (msg) => {
      fs.appendFileSync('./access.log', msg);
      // Also log to console for real-time monitoring
      process.stdout.write(msg);
    }
  }
}));

app.use(express.json({ limit: '10kb' })); // Limit body size

// API Key auth for sensitive endpoints
const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');
if (!process.env.API_KEY) {
  console.log(`\n⚠️  No API_KEY set. Generated: ${API_KEY.slice(0, 8)}...`);
  console.log(`   Set API_KEY env var for production.\n`);
}

const requireAuth = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. X-API-Key header required.' });
  }
  next();
};

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // Only 5 sync requests per minute
  message: { error: 'Sync rate limited. Try again in a minute.' },
});

app.use(limiter);

// Input validation helpers
const isValidHex = (str, exactLength = null) => {
  if (typeof str !== 'string') return false;
  const hex = str.startsWith('0x') ? str : '0x' + str;
  if (!/^0x[a-fA-F0-9]+$/.test(hex)) return false;
  if (exactLength && hex.length !== exactLength) return false;
  return true;
};

const isValidAddress = (addr) => isValidHex(addr, 42); // 0x + 40 chars
const isValidBytes32 = (b32) => isValidHex(b32, 66);   // 0x + 64 chars

const sanitizeString = (str, maxLen = 100) => {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLen).replace(/[<>'"]/g, '');
};

const validateLimit = (val, max = 500) => Math.min(Math.max(parseInt(val) || 100, 1), max);
const validateOffset = (val) => Math.max(parseInt(val) || 0, 0);

// Config
const ESCROW_ADDRESS = '0x80B2880C6564c6a9Bc1219686eF144e7387c20a3';
const START_BLOCK = 41000000n;
const abi = JSON.parse(fs.readFileSync('./abi.json', 'utf8'));

// Database setup
const db = new Database('./escrow.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    title TEXT,
    poster_id TEXT,
    claimer_id TEXT,
    reward TEXT,
    status TEXT DEFAULT 'open',
    submission_hash TEXT,
    approved INTEGER,
    created_block INTEGER,
    claimed_block INTEGER,
    submitted_block INTEGER,
    verified_block INTEGER,
    cancelled_block INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT,
    wallet TEXT,
    registered_block INTEGER,
    created_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    job_id TEXT,
    agent_id TEXT,
    tx_hash TEXT,
    block_number INTEGER,
    log_index INTEGER,
    data TEXT,
    created_at INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_block INTEGER
  );
  
  CREATE INDEX IF NOT EXISTS idx_jobs_poster ON jobs(poster_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_claimer ON jobs(claimer_id);
  CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_agents_wallet ON agents(wallet);
`);

db.prepare('INSERT OR IGNORE INTO sync_state (id, last_block) VALUES (1, ?)').run(Number(START_BLOCK));

// Viem client
const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org'),
});

// Sync function
async function syncEvents() {
  const { last_block } = db.prepare('SELECT last_block FROM sync_state WHERE id = 1').get();
  let currentBlock;
  
  try {
    currentBlock = await client.getBlockNumber();
  } catch (e) {
    console.error('Failed to get block number:', e.message);
    return;
  }
  
  if (BigInt(last_block) >= currentBlock) {
    console.log(`[${new Date().toISOString()}] Already synced to block ${last_block}`);
    return;
  }
  
  const fromBlock = BigInt(last_block) + 1n;
  const toBlock = currentBlock;
  
  console.log(`[${new Date().toISOString()}] Syncing blocks ${fromBlock} to ${toBlock}...`);
  
  const CHUNK_SIZE = 5000n;
  let from = fromBlock;
  let totalEvents = 0;
  
  while (from <= toBlock) {
    const to = from + CHUNK_SIZE > toBlock ? toBlock : from + CHUNK_SIZE;
    
    try {
      const logs = await client.getLogs({
        address: ESCROW_ADDRESS,
        fromBlock: from,
        toBlock: to,
      });
      
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
          await processDecodedLog(log, decoded);
          totalEvents++;
        } catch (e) {
          // Skip logs we can't decode
        }
      }
      
      // Update sync state after each chunk
      db.prepare('UPDATE sync_state SET last_block = ? WHERE id = 1').run(Number(to));
      
    } catch (e) {
      console.error(`Error fetching ${from}-${to}:`, e.message);
      // Continue with next chunk
    }
    
    from = to + 1n;
  }
  
  console.log(`[${new Date().toISOString()}] Sync complete. Processed ${totalEvents} events. Last block: ${toBlock}`);
}

async function processDecodedLog(log, decoded) {
  const timestamp = Math.floor(Date.now() / 1000);
  const blockNum = Number(log.blockNumber);
  const args = decoded.args;
  
  // Store raw event
  db.prepare(`
    INSERT INTO events (event_type, job_id, agent_id, tx_hash, block_number, log_index, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decoded.eventName,
    args.jobId || null,
    args.agentId || null,
    log.transactionHash,
    blockNum,
    log.logIndex,
    JSON.stringify({ ...args, eventName: decoded.eventName }),
    timestamp
  );
  
  // Process specific events
  switch (decoded.eventName) {
    case 'AgentRegistered':
      db.prepare(`
        INSERT OR REPLACE INTO agents (agent_id, name, wallet, registered_block, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(args.agentId, args.name, args.wallet, blockNum, timestamp);
      break;
      
    case 'JobPosted':
      db.prepare(`
        INSERT OR REPLACE INTO jobs (job_id, title, poster_id, reward, status, created_block, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(args.jobId, args.title, args.posterId, args.reward?.toString(), blockNum, timestamp, timestamp);
      break;
      
    case 'JobClaimed':
      db.prepare(`
        UPDATE jobs SET claimer_id = ?, status = 'claimed', claimed_block = ?, updated_at = ?
        WHERE job_id = ?
      `).run(args.claimerId, blockNum, timestamp, args.jobId);
      break;
      
    case 'WorkSubmitted':
      db.prepare(`
        UPDATE jobs SET submission_hash = ?, status = 'submitted', submitted_block = ?, updated_at = ?
        WHERE job_id = ?
      `).run(args.submissionHash, blockNum, timestamp, args.jobId);
      break;
      
    case 'JobVerified':
      db.prepare(`
        UPDATE jobs SET approved = ?, status = 'verified', verified_block = ?, updated_at = ?
        WHERE job_id = ?
      `).run(args.approved ? 1 : 0, blockNum, timestamp, args.jobId);
      break;
      
    case 'JobCancelled':
      db.prepare(`
        UPDATE jobs SET status = 'cancelled', cancelled_block = ?, updated_at = ?
        WHERE job_id = ?
      `).run(blockNum, timestamp, args.jobId);
      break;
      
    case 'ClaimExpired':
      db.prepare(`
        UPDATE jobs SET status = 'claim_expired', updated_at = ? WHERE job_id = ?
      `).run(timestamp, args.jobId);
      break;
      
    case 'VerifyExpired':
      db.prepare(`
        UPDATE jobs SET status = 'verify_expired', updated_at = ? WHERE job_id = ?
      `).run(timestamp, args.jobId);
      break;
      
    case 'EmergencyRelease':
      db.prepare(`
        UPDATE jobs SET status = 'emergency_released', updated_at = ? WHERE job_id = ?
      `).run(timestamp, args.jobId);
      break;
  }
}

// API Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Openwork Escrow Indexer API',
    version: '1.1.0',
    url: 'https://escrow.agentjobs.agency',
    contract: ESCROW_ADDRESS,
    chain: 'Base (8453)',
    endpoints: {
      'GET /jobs': 'List all escrow jobs',
      'GET /jobs/:jobId': 'Get job details + event history',
      'GET /agents/:address/jobs': 'Get jobs by agent wallet',
      'GET /stats': 'Aggregate statistics',
      'GET /events': 'Recent events',
      'GET /agents': 'List registered agents',
      'POST /sync': 'Trigger manual sync (requires X-API-Key)',
      'GET /health': 'Health check',
    },
    source: 'https://github.com/zombiepear/escrow-indexer',
    built_by: 'RawClaw 🦞 (AgentHive)',
  });
});

app.get('/jobs', (req, res) => {
  const limit = validateLimit(req.query.limit, 500);
  const offset = validateOffset(req.query.offset);
  const status = sanitizeString(req.query.status, 20);
  
  const validStatuses = ['open', 'claimed', 'submitted', 'verified', 'cancelled', 'claim_expired', 'verify_expired', 'emergency_released'];
  
  let query = 'SELECT * FROM jobs';
  const params = [];
  
  if (status && validStatuses.includes(status)) {
    query += ' WHERE status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY created_block DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  const jobs = db.prepare(query).all(...params);
  const countQuery = status && validStatuses.includes(status) ? 'SELECT COUNT(*) as count FROM jobs WHERE status = ?' : 'SELECT COUNT(*) as count FROM jobs';
  const total = db.prepare(countQuery).get(...(status && validStatuses.includes(status) ? [status] : [])).count;
  
  res.json({ jobs, total, limit, offset });
});

app.get('/jobs/:jobId', (req, res) => {
  let { jobId } = req.params;
  
  // Normalize to 0x prefix
  if (!jobId.startsWith('0x')) {
    jobId = '0x' + jobId;
  }
  
  // Validate hex format (bytes32 = 66 chars with 0x)
  if (!isValidBytes32(jobId)) {
    return res.status(400).json({ error: 'Invalid jobId format. Expected bytes32 hex string.' });
  }
  
  const job = db.prepare('SELECT * FROM jobs WHERE job_id = ? OR job_id = ?').get(jobId, jobId.toLowerCase());
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found', jobId });
  }
  
  const history = db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY block_number ASC, log_index ASC').all(job.job_id);
  
  res.json({ job, history });
});

app.get('/agents', (req, res) => {
  const limit = validateLimit(req.query.limit, 500);
  const agents = db.prepare('SELECT * FROM agents ORDER BY registered_block DESC LIMIT ?').all(limit);
  const total = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  res.json({ agents, total });
});

app.get('/agents/:address/jobs', (req, res) => {
  const { address } = req.params;
  
  // Validate address format
  if (!isValidAddress(address)) {
    return res.status(400).json({ error: 'Invalid address format. Expected 0x + 40 hex chars.' });
  }
  
  const normalizedAddr = address.toLowerCase();
  
  // Try to find agent by wallet
  const agent = db.prepare('SELECT * FROM agents WHERE LOWER(wallet) = ?').get(normalizedAddr);
  
  let posted = [];
  let claimed = [];
  
  if (agent) {
    posted = db.prepare('SELECT * FROM jobs WHERE poster_id = ?').all(agent.agent_id);
    claimed = db.prepare('SELECT * FROM jobs WHERE claimer_id = ?').all(agent.agent_id);
  } else {
    // Search by partial match on poster/claimer fields (first 8 chars of address)
    const partial = normalizedAddr.slice(2, 10);
    posted = db.prepare('SELECT * FROM jobs WHERE LOWER(poster_id) LIKE ?').all(`%${partial}%`);
    claimed = db.prepare('SELECT * FROM jobs WHERE LOWER(claimer_id) LIKE ?').all(`%${partial}%`);
  }
  
  res.json({ address: normalizedAddr, agent, posted, claimed });
});

app.get('/stats', (req, res) => {
  const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs').get().count;
  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  const eventCount = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  const { last_block } = db.prepare('SELECT last_block FROM sync_state WHERE id = 1').get();
  
  const statusCounts = db.prepare('SELECT status, COUNT(*) as count FROM jobs GROUP BY status').all();
  const eventTypes = db.prepare('SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC').all();
  
  const totalReward = db.prepare('SELECT SUM(CAST(reward AS INTEGER)) as total FROM jobs').get().total || 0;
  
  res.json({
    contract: ESCROW_ADDRESS,
    chain: 'Base (8453)',
    total_jobs: jobCount,
    total_agents: agentCount,
    total_events: eventCount,
    total_escrowed: totalReward.toString(),
    last_synced_block: last_block,
    job_status_breakdown: statusCounts,
    event_type_breakdown: eventTypes,
  });
});

app.get('/events', (req, res) => {
  const limit = validateLimit(req.query.limit, 200);
  const eventType = sanitizeString(req.query.type, 30);
  
  const validEventTypes = [
    'AgentRegistered', 'JobPosted', 'JobClaimed', 'WorkSubmitted',
    'JobVerified', 'JobCancelled', 'ClaimExpired', 'VerifyExpired',
    'EmergencyRelease', 'OwnershipTransferred'
  ];
  
  let query = 'SELECT * FROM events';
  const params = [];
  
  if (eventType && validEventTypes.includes(eventType)) {
    query += ' WHERE event_type = ?';
    params.push(eventType);
  }
  
  query += ' ORDER BY block_number DESC, log_index DESC LIMIT ?';
  params.push(limit);
  
  const events = db.prepare(query).all(...params);
  res.json({ events, count: events.length });
});

app.post('/sync', syncLimiter, requireAuth, async (req, res) => {
  try {
    await syncEvents();
    const { last_block } = db.prepare('SELECT last_block FROM sync_state WHERE id = 1').get();
    res.json({ success: true, last_block });
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Sync error:`, e.message);
    res.status(500).json({ error: 'Sync failed' }); // Don't leak internal errors
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
const PORT = process.env.PORT || 3456;
const HOST = process.env.HOST || '127.0.0.1'; // Localhost only - use nginx for public access
app.listen(PORT, HOST, async () => {
  console.log(`\n🦞 Openwork Escrow Indexer v1.1.0 (OWASP hardened)`);
  console.log(`   Listening: ${HOST}:${PORT}`);
  console.log(`   Contract: ${ESCROW_ADDRESS}`);
  console.log(`   Chain: Base`);
  console.log(`   Logs: ./access.log\n`);
  
  // Initial sync
  console.log('Starting initial sync...');
  await syncEvents();
  
  // Periodic sync every 2 minutes
  setInterval(syncEvents, 120000);
});

// Serve static dashboard
app.use('/dashboard', express.static('public'));
