require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { connectToSWIM, getSnapshot, setScrapedRestrictions, setCurrentReroutes, setNasClosures, setOpsPlan, setAirportOperations, addListener, removeListener } = require('./src/swim');
const { fetchRestrictions, fetchCurrentReroutes, fetchNasClosures, fetchAirportOperations, fetchOpsPlan } = require('./src/scraper');

const app = express();
app.use(cors());

// REST endpoint: full snapshot of current state
app.get('/api/state', (req, res) => {
    res.json(getSnapshot());
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ ok: true, connected: getSnapshot().connected });
});

const server = http.createServer(app);

// WebSocket: push live updates to browser
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
    console.log('Browser connected via WebSocket');

    // Send full snapshot immediately on connect
    ws.send(JSON.stringify({ event: 'snapshot', data: getSnapshot() }));

    const listener = (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(msg);
    };
    addListener(listener);

    ws.on('close', () => {
        removeListener(listener);
        console.log('Browser disconnected');
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
    connectToSWIM();
    refreshRestrictions();
});

async function refreshRestrictions() {
    try {
        const [restrictions, reroutes, closures, airportOperations, plan] = await Promise.all([fetchRestrictions(), fetchCurrentReroutes(), fetchNasClosures(), fetchAirportOperations(), fetchOpsPlan()]);
        const opsClosures = Object.values(plan.airportImpacts || {}).flat().map(impact => ({
            id: impact.id,
            aerodrome: `K${impact.airport}`,
            name: impact.plainLanguage,
            state: impact.status,
            startTime: impact.startTime,
            endTime: impact.endTime,
            runways: impact.kind === 'RUNWAY'
                ? extractRunways(impact.detail)
                : [],
            kind: impact.kind,
            source: 'OPS_PLAN',
        }));
        setScrapedRestrictions(restrictions);
        setCurrentReroutes(reroutes);
        setNasClosures([...closures, ...opsClosures]);
        setOpsPlan(plan);
        setAirportOperations(airportOperations);
        console.log(`Loaded ${restrictions.length} FAA restrictions, ${reroutes.length} current reroutes, ${closures.length} NAS closures, and ${plan.sections.length} ops-plan sections`);
    } catch (error) {
        console.error('FAA restrictions refresh failed:', error.message);
    }
}

function extractRunways(detail) {
    const runwayText = detail.match(/^RWY\s+(.+?)(?=\s+(?:CLOSED|CLOSURES|LIMITED|CONSTRUCTION|W\/|UNTIL|\d{2}\/))/i)?.[1];
    return runwayText
        ? runwayText.split(/\s+-\s+|\//).map(runway => runway.trim()).filter(Boolean)
        : [];
}

setInterval(refreshRestrictions, 60 * 1000);
