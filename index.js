const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for uptime data
let monitors = [];
let uptimeHistory = new Map(); // Map<monitorId, Array<{timestamp, status, responseTime}>>

// Load configuration
function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            monitors = config.monitors || [];

            // Initialize history for new monitors
            monitors.forEach(monitor => {
                if (!uptimeHistory.has(monitor.id)) {
                    uptimeHistory.set(monitor.id, []);
                }
            });

            console.log(`Loaded ${monitors.length} monitors from config`);
        } else {
            // Create default config
            const defaultConfig = {
                monitors: [
                    {
                        id: 'example-1',
                        name: 'Example Website',
                        url: 'https://httpbin.org/status/200',
                        interval: '*/2 * * * *' // Every 2 minutes
                    },
                    {
                        id: 'example-2',
                        name: 'Google',
                        url: 'https://google.com',
                        interval: '*/5 * * * *' // Every 5 minutes
                    }
                ]
            };

            fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
            monitors = defaultConfig.monitors;

            monitors.forEach(monitor => {
                uptimeHistory.set(monitor.id, []);
            });

            console.log('Created default config.json with example monitors');
        }
    } catch (error) {
        console.error('Error loading config:', error);
        monitors = [];
    }
}

// Check monitor status
async function checkMonitor(monitor) {
    const startTime = Date.now();

    try {
        const response = await axios.get(monitor.url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'UptimeRobot/1.0'
            }
        });

        const responseTime = Date.now() - startTime;
        const status = response.status >= 200 && response.status < 400 ? 'up' : 'down';

        // Store in history (keep last 100 entries per monitor)
        const history = uptimeHistory.get(monitor.id) || [];
        history.push({
            timestamp: new Date().toISOString(),
            status,
            responseTime,
            statusCode: response.status
        });

        // Keep only last 100 entries
        if (history.length > 100) {
            history.shift();
        }

        uptimeHistory.set(monitor.id, history);

        console.log(`✓ ${monitor.name}: ${status} (${responseTime}ms)`);

        return { status, responseTime, statusCode: response.status };

    } catch (error) {
        const responseTime = Date.now() - startTime;

        // Store failed check in history
        const history = uptimeHistory.get(monitor.id) || [];
        history.push({
            timestamp: new Date().toISOString(),
            status: 'down',
            responseTime,
            error: error.message,
            statusCode: error.response?.status || 0
        });

        if (history.length > 100) {
            history.shift();
        }

        uptimeHistory.set(monitor.id, history);

        console.log(`✗ ${monitor.name}: down (${error.message})`);

        return { status: 'down', responseTime, error: error.message, statusCode: error.response?.status || 0 };
    }
}

// Calculate uptime percentage
function calculateUptime(monitorId, hours = 24) {
    const history = uptimeHistory.get(monitorId) || [];
    if (history.length === 0) return 0;

    const cutoffTime = new Date(Date.now() - (hours * 60 * 60 * 1000));
    const recentHistory = history.filter(entry => new Date(entry.timestamp) > cutoffTime);

    if (recentHistory.length === 0) return 0;

    const upCount = recentHistory.filter(entry => entry.status === 'up').length;
    return Math.round((upCount / recentHistory.length) * 100 * 100) / 100;
}

// Get monitor status with statistics
function getMonitorStatus(monitor) {
    const history = uptimeHistory.get(monitor.id) || [];
    const latest = history[history.length - 1];

    return {
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        status: latest?.status || 'unknown',
        lastChecked: latest?.timestamp || null,
        responseTime: latest?.responseTime || null,
        statusCode: latest?.statusCode || null,
        uptime24h: calculateUptime(monitor.id, 24),
        uptime7d: calculateUptime(monitor.id, 24 * 7),
        totalChecks: history.length
    };
}

// Setup cron jobs for monitors
function setupCronJobs() {
    // Clear existing cron jobs
    cron.getTasks().forEach(task => task.stop());

    monitors.forEach(monitor => {
        cron.schedule(monitor.interval, () => {
            checkMonitor(monitor);
        });
    });

    console.log(`Setup ${monitors.length} cron jobs`);
}

// Middleware
app.use(express.static('public'));
app.use(express.json());

// API endpoint to get all monitors status
app.get('/api/monitors', (req, res) => {
    const monitorStatuses = monitors.map(monitor => getMonitorStatus(monitor));

    res.json({
        monitors: monitorStatuses,
        lastUpdated: new Date().toISOString(),
        totalMonitors: monitors.length
    });
});

// API endpoint to get specific monitor
app.get('/api/monitors/:id', (req, res) => {
    const monitor = monitors.find(m => m.id === req.params.id);
    if (!monitor) {
        return res.status(404).json({ error: 'Monitor not found' });
    }

    const status = getMonitorStatus(monitor);
    const history = uptimeHistory.get(monitor.id) || [];

    res.json({
        ...status,
        history: history.slice(-24) // Last 24 entries
    });
});

// Main status page
app.get('/', (req, res) => {
    const monitorStatuses = monitors.map(monitor => getMonitorStatus(monitor));

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Uptime Monitor Status</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        async function updateHealthBar(monitorId) {
            try {
                const response = await fetch(\`/api/monitors/\${monitorId}\`);
                const data = await response.json();
                
                const healthBarContainer = document.querySelector(\`[data-monitor-id="\${monitorId}"] .flex\`);
                if (healthBarContainer && data.history) {
                    // Get last 30 entries for the health bar
                    const recentHistory = data.history.slice(-30);
                    
                    healthBarContainer.innerHTML = recentHistory.map(entry => \`
                        <div class="flex-1 h-full \${entry.status === 'up' ? 'bg-green-500' : 'bg-red-500'}" 
                             title="\${entry.status === 'up' ? 'Up' : 'Down'} - \${new Date(entry.timestamp).toLocaleString()} (\${entry.responseTime}ms)">
                        </div>
                    \`).join('');
                    
                    // If we have fewer than 30 entries, fill the rest with gray
                    const remaining = 30 - recentHistory.length;
                    if (remaining > 0) {
                        for (let i = 0; i < remaining; i++) {
                            healthBarContainer.innerHTML += \`<div class="flex-1 h-full bg-gray-200" title="No data"></div>\`;
                        }
                    }
                }
            } catch (error) {
                console.error(\`Failed to update health bar for \${monitorId}:\`, error);
            }
        }
        
        async function updateStatus() {
            try {
                const response = await fetch('/api/monitors');
                const data = await response.json();
                
                const container = document.getElementById('monitors-container');
                container.innerHTML = data.monitors.map(monitor => \`
                    <div class="bg-white rounded-lg shadow-md p-6 border-l-4 \${monitor.status === 'up' ? 'border-green-500' : monitor.status === 'down' ? 'border-red-500' : 'border-gray-500'}">
                        <div class="flex items-center justify-between mb-4">
                            <div class="flex items-center space-x-3">
                                <div class="w-3 h-3 rounded-full \${monitor.status === 'up' ? 'bg-green-500' : monitor.status === 'down' ? 'bg-red-500' : 'bg-gray-500'}"></div>
                                <div>
                                    <div class="text-lg font-semibold text-gray-900">\${monitor.name}</div>
                                    <div class="text-sm text-gray-500">\${monitor.url}</div>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="text-sm font-medium \${monitor.status === 'up' ? 'text-green-600' : monitor.status === 'down' ? 'text-red-600' : 'text-gray-600'} uppercase">
                                    \${monitor.status}
                                </div>
                                <div class="text-xs text-gray-500">
                                    \${monitor.responseTime ? monitor.responseTime + 'ms' : 'N/A'}
                                </div>
                            </div>
                        </div>
                        
                        <div class="grid grid-cols-3 gap-4 mt-4">
                            <div class="text-center">
                                <div class="text-2xl font-bold text-gray-900">\${monitor.uptime24h}%</div>
                                <div class="text-xs text-gray-500">24h Uptime</div>
                            </div>
                            <div class="text-center">
                                <div class="text-2xl font-bold text-gray-900">\${monitor.uptime7d}%</div>
                                <div class="text-xs text-gray-500">7d Uptime</div>
                            </div>
                            <div class="text-center">
                                <div class="text-2xl font-bold text-gray-900">\${monitor.totalChecks}</div>
                                <div class="text-xs text-gray-500">Total Checks</div>
                            </div>
                        </div>
                        
                        <div class="mt-4 text-xs text-gray-500">
                            Last checked: \${monitor.lastChecked ? new Date(monitor.lastChecked).toLocaleString() : 'Never'}
                        </div>
                    </div>
                \`).join('');
                
                document.getElementById('last-updated').textContent = 'Last updated: ' + new Date(data.lastUpdated).toLocaleString();
            } catch (error) {
                console.error('Failed to update status:', error);
            }
        }
        
        async function updateHealthBarIframe(monitorId) {
            try {
                const response = await fetch(\`/api/monitors/\${monitorId}\`);
                const data = await response.json();
                
                const healthBarContainer = document.querySelector(\`[data-monitor-id="\${monitorId}"] .flex\`);
                if (healthBarContainer && data.history) {
                    // Get last 20 entries for the compact iframe health bar
                    const recentHistory = data.history.slice(-20);
                    
                    healthBarContainer.innerHTML = recentHistory.map(entry => \`
                        <div class="flex-1 h-full \${entry.status === 'up' ? 'bg-green-500' : 'bg-red-500'}" 
                             title="\${entry.status === 'up' ? 'Up' : 'Down'} - \${new Date(entry.timestamp).toLocaleString()}">
                        </div>
                    \`).join('');
                    
                    // If we have fewer than 20 entries, fill the rest with gray
                    const remaining = 20 - recentHistory.length;
                    if (remaining > 0) {
                        for (let i = 0; i < remaining; i++) {
                            healthBarContainer.innerHTML += \`<div class="flex-1 h-full bg-gray-200" title="No data"></div>\`;
                        }
                    }
                }
            } catch (error) {
                console.error(\`Failed to update health bar for \${monitorId}:\`, error);
            }
        }
        
        // Update on page load and every 30 seconds
        document.addEventListener('DOMContentLoaded', () => {
            updateStatus();
            setInterval(updateStatus, 30000);
        });
    </script>
</head>
<body class="bg-gray-100 min-h-screen">
    <div class="container mx-auto px-4 py-8">
        <div class="text-center mb-8">
            <div class="text-3xl font-bold text-gray-900 mb-2">Service Status</div>
            <div class="text-gray-600">Real-time monitoring of our services</div>
            <div id="last-updated" class="text-sm text-gray-500 mt-2"></div>
        </div>
        
        <div id="monitors-container" class="space-y-4 max-w-4xl mx-auto">
            Loading...
        </div>
        
        <div class="text-center mt-8">
            <div class="text-sm text-gray-500">
                <a href="/iframe" class="text-blue-600 hover:text-blue-800">Embed Version</a> | 
                <a href="/api/monitors" class="text-blue-600 hover:text-blue-800">API</a>
            </div>
        </div>
    </div>
</body>
</html>
  `);
});

// Iframe-friendly status page
app.get('/iframe', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Uptime Status - Embed</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        async function updateStatus() {
            try {
                const response = await fetch('/api/monitors');
                const data = await response.json();
                
                const container = document.getElementById('monitors-container');
                container.innerHTML = data.monitors.map(monitor => \`
                    <div class="bg-white rounded border p-4 shadow-sm">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center space-x-2">
                                <div class="w-2 h-2 rounded-full \${monitor.status === 'up' ? 'bg-green-500' : monitor.status === 'down' ? 'bg-red-500' : 'bg-gray-500'}"></div>
                                <div>
                                    <div class="font-medium text-sm text-gray-900">\${monitor.name}</div>
                                    <div class="text-xs text-gray-500">\${monitor.uptime24h}% uptime</div>
                                </div>
                            </div>
                            <div class="text-right">
                                <div class="text-xs font-medium \${monitor.status === 'up' ? 'text-green-600' : monitor.status === 'down' ? 'text-red-600' : 'text-gray-600'} uppercase">
                                    \${monitor.status}
                                </div>
                                <div class="text-xs text-gray-500">
                                    \${monitor.responseTime ? monitor.responseTime + 'ms' : 'N/A'}
                                </div>
                            </div>
                        </div>
                    </div>
                \`).join('');
            } catch (error) {
                console.error('Failed to update status:', error);
            }
        }
        
        // Update on page load and every 30 seconds
        document.addEventListener('DOMContentLoaded', () => {
            updateStatus();
            setInterval(updateStatus, 30000);
        });
    </script>
</head>
<body class="bg-gray-50">
    <div class="p-4">
        <div class="text-center mb-4">
            <div class="text-lg font-bold text-gray-900">Service Status</div>
        </div>
        
        <div id="monitors-container" class="space-y-2">
            Loading...
        </div>
    </div>
</body>
</html>
  `);
});

// Manual check endpoint
app.post('/api/monitors/:id/check', async (req, res) => {
    const monitor = monitors.find(m => m.id === req.params.id);
    if (!monitor) {
        return res.status(404).json({ error: 'Monitor not found' });
    }

    const result = await checkMonitor(monitor);
    const status = getMonitorStatus(monitor);

    res.json(status);
});

// Initialize and start server
loadConfig();
setupCronJobs();

// Initial check of all monitors
setTimeout(() => {
    monitors.forEach(monitor => checkMonitor(monitor));
}, 1000);

app.listen(PORT, () => {
    console.log(`Uptime Robot server running on port ${PORT}`);
    console.log(`Status page: http://localhost:${PORT}`);
    console.log(`Iframe page: http://localhost:${PORT}/iframe`);
    console.log(`API endpoint: http://localhost:${PORT}/api/monitors`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down uptime robot...');
    cron.getTasks().forEach(task => task.stop());
    process.exit(0);
});