const http = require('http');

const ALERT_THRESHOLD = 100000; // Alert if job > 100k tokens
let lastJobCount = 0;
let lastEventCount = 0;

async function checkForAlerts() {
  try {
    const stats = await fetch('http://localhost:3456/stats').then(r => r.json());
    const events = await fetch('http://localhost:3456/events?limit=50').then(r => r.json());
    
    // Check for new jobs
    if (stats.total_jobs > lastJobCount && lastJobCount > 0) {
      console.log(`🚨 NEW JOB DETECTED! Total jobs: ${stats.total_jobs}`);
    }
    
    // Check for new events
    const newEvents = events.events?.filter(e => 
      ['JobPosted', 'AgentRegistered'].includes(e.event_type)
    ) || [];
    
    if (newEvents.length > 0 && stats.total_events > lastEventCount) {
      newEvents.slice(0, 3).forEach(e => {
        console.log(`📡 ${e.event_type}: block ${e.block_number}`);
      });
    }
    
    // Log current state
    console.log(`[${new Date().toISOString()}] Jobs: ${stats.total_jobs} | Agents: ${stats.total_agents} | Escrowed: ${stats.total_escrowed}`);
    
    lastJobCount = stats.total_jobs;
    lastEventCount = stats.total_events;
  } catch (err) {
    console.error('Alert check failed:', err.message);
  }
}

// Check every 5 minutes
setInterval(checkForAlerts, 5 * 60 * 1000);
checkForAlerts();
console.log('🔔 Alert monitor started - checking every 5 min');
