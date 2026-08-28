require('dotenv').config();
const solace = require('solclientjs');
const xml2js = require('xml2js');

const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });

// Types we actually care about
const RELEVANT_TYPES = new Set(['STOP', 'GDP', 'GS', 'MINIT', 'MIT', 'EDCT', 'REROUTE']);
// Statuses worth showing
const SHOW_STATUSES = new Set(['ACTIVE', 'PROPOSED']);

function isCurrent(tmi) {
    // If there's an end time and it's already passed, skip it
    if (tmi.endTime && new Date(tmi.endTime) < new Date()) return false;
    // If proposed, only show if starts within the next 4 hours
    if (tmi.status === 'PROPOSED' && tmi.startTime) {
        const start = new Date(tmi.startTime);
        const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
        if (start > fourHoursFromNow) return false;
    }
    return true;
}

function isRelevant(tmi) {
    if (!RELEVANT_TYPES.has(tmi.type)) return false;
    if (!SHOW_STATUSES.has(tmi.status)) return false;
    if (!isCurrent(tmi)) return false;
    return true;
}

// In-memory store: id -> tmi object
const allTMIs = new Map();
let scrapedRestrictions = [];
let currentReroutes = [];
let opsPlan = null;
let airportOperations = null;
// Airport closures: aerodrome -> closure list
const runwayClosures = new Map();
const nasClosures = new Map();

const listeners = new Set();
let swimConnected = false;
let lastUpdated = null;
let reconnectTimer = null;

function broadcast(event, data) {
    const msg = JSON.stringify({ event, data, ts: new Date().toISOString() });
    for (const fn of listeners) fn(msg);
}

function addListener(fn) { listeners.add(fn); }
function removeListener(fn) { listeners.delete(fn); }

function getFilteredTMIs() {
    return Array.from(allTMIs.values()).filter(isRelevant);
}

function getSnapshot() {
    const restrictions = [...scrapedRestrictions, ...getFilteredTMIs()];
    const uniqueRestrictions = Array.from(new Map(
        restrictions.map(restriction => [
            `${restriction.requestingFacility || ''}|${restriction.providingFacility || ''}|${restriction.name || restriction.id}`,
            restriction,
        ])
    ).values());

    return {
        connected: swimConnected,
        lastUpdated,
        restrictions: uniqueRestrictions,
        reroutes: currentReroutes,
        runwayClosures: Object.fromEntries(new Map([...nasClosures, ...runwayClosures])),
        opsPlan,
        airportOperations,
    };
}

function setNasClosures(closures) {
    nasClosures.clear();
    for (const closure of closures) {
        const airportClosures = nasClosures.get(closure.aerodrome) || [];
        airportClosures.push(closure);
        nasClosures.set(closure.aerodrome, airportClosures);
    }
    broadcast('update', getSnapshot());
}

function setOpsPlan(plan) {
    opsPlan = plan;
    broadcast('update', getSnapshot());
}

function setAirportOperations(operations) {
    airportOperations = operations;
    broadcast('update', getSnapshot());
}

function setScrapedRestrictions(restrictions) {
    scrapedRestrictions = restrictions;
    broadcast('update', getSnapshot());
}

function setCurrentReroutes(reroutes) {
    currentReroutes = reroutes;
    broadcast('update', getSnapshot());
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToSWIM();
    }, 10000);
    console.warn('SWIM disconnected; retrying in 10 seconds');
}

async function handleMessage(xmlString) {
    let parsed;
    try {
        parsed = await parser.parseStringPromise(xmlString);
    } catch (e) {
        return;
    }

    lastUpdated = new Date().toISOString();
    let changed = false;

    // --- Traffic Management Restrictions ---
    const tmrRoot = parsed['trafficManagementRestrictions'];
    if (tmrRoot) {
        const aerodrome = tmrRoot['aerodrome'];
        const tmiList = tmrRoot['tmiList'];
        if (!aerodrome || !tmiList) return;

        const tmis = Array.isArray(tmiList['tmi'])
            ? tmiList['tmi']
            : [tmiList['tmi']].filter(Boolean);

        for (const raw of tmis) {
            const id = raw?.tfdmTmiId?.identification;
            if (!id) continue;

            const action = raw['tmrAction'];
            if (action === 'DELETE') {
                if (allTMIs.delete(id)) changed = true;
                continue;
            }

            const tmi = {
                id,
                aerodrome,
                action,
                name: raw['tmiName'],
                type: raw['tmiType'],
                status: raw['tmiStatus'],
                startTime: raw['startTime'] || null,
                endTime: raw['endTime'] || null,
                untilFurtherNotice: raw['untilFurtherNotice'] === 'true',
                nasElement: raw['nasElement'] || null,
                controlledElement: raw['controlledElement'] || null,
                milesInTrail: parseInt(raw['milesInTrailSpacing']) || 0,
                minutesInTrail: parseInt(raw['minutesInTrailSpacing']) || 0,
                reason: (raw['reason'] || '').replace(/:/g, ' ').trim() || null,
                restriction: raw['restriction'] || null,   // DEPARTURES / ARRIVALS
                providingFacility: raw['providingFacility'] || null,
                requestingFacility: raw['requestingFacility'] || null,
            };

            allTMIs.set(id, tmi);
            changed = true;
        }
    }

    // --- Airport Information (runway closures only) ---
    const aptRoot = parsed['airportInformationData'];
    if (aptRoot) {
        const aerodrome = aptRoot['aerodrome'];
        if (!aerodrome) return;

        const closuresNode = aptRoot['closures'];
        if (closuresNode) {
            const closureData = Array.isArray(closuresNode['closureData'])
                ? closuresNode['closureData']
                : [closuresNode['closureData']].filter(Boolean);

            const active = closureData.filter(c =>
                ['ACTIVATED', 'SCHEDULED'].includes(c['closureState']) &&
                (!c['closureEndTime'] || new Date(c['closureEndTime']) > new Date())
            ).map(c => ({
                id: c?.closureId?.identification,
                aerodrome,
                name: (c['closureName'] || '').trim(),
                state: c['closureState'],
                startTime: c['closureStartTime'] || null,
                endTime: c['closureEndTime'] || null,
                runways: (() => {
                    const rw = c?.closedRegions?.closedRunways?.runway;
                    if (!rw) return [];
                    return Array.isArray(rw) ? rw : [rw];
                })(),
            }));

            if (active.length > 0) {
                runwayClosures.set(aerodrome, active);
            } else {
                runwayClosures.delete(aerodrome);
            }
            changed = true;
        }
    }

    if (changed) {
        broadcast('update', getSnapshot());
    }
}

function connectToSWIM() {
    console.log('Connecting to FAA SWIM (TFDM)...');

    const factoryProps = new solace.SolclientFactoryProperties();
    factoryProps.profile = solace.SolclientFactoryProfiles.version10;
    solace.SolclientFactory.init(factoryProps);

    const session = solace.SolclientFactory.createSession({
        url: process.env.SWIM_URL,
        vpnName: process.env.SWIM_VPN,
        userName: process.env.SWIM_USERNAME,
        password: process.env.SWIM_PASSWORD,
        reconnectRetries: 0,
        connectRetries: 1,
    });

    session.on(solace.SessionEventCode.UP_NOTICE, () => {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        console.log('=== Connected to FAA SWIM! ===');
        swimConnected = true;
        broadcast('status', { connected: true });

        const consumer = session.createMessageConsumer({
            queueDescriptor: { name: process.env.SWIM_QUEUE, type: solace.QueueType.QUEUE },
            acknowledgeMode: solace.MessageConsumerAcknowledgeMode.AUTO_ACK,
        });

        consumer.on(solace.MessageConsumerEventName.UP, () => {
            console.log('=== Bound to queue. Receiving messages... ===');
        });

        consumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
            let payload = null;
            if (message.getBinaryAttachment()) payload = message.getBinaryAttachment().toString('utf8');
            else if (message.getXmlContent()) payload = message.getXmlContent();
            else if (message.getSdtContainer()) payload = message.getSdtContainer().getValue();
            if (payload) handleMessage(payload);
        });

        consumer.on(solace.MessageConsumerEventName.DOWN_ERROR, (e) => {
            console.error('Consumer error:', e.toString());
            swimConnected = false;
            broadcast('status', { connected: false });
        });

        consumer.connect();
    });

    session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
        console.error('SWIM connection failed:', e.infoStr);
        swimConnected = false;
        scheduleReconnect();
    });

    session.on(solace.SessionEventCode.DOWN_ERROR, (e) => {
        console.error('SWIM session error:', e.infoStr);
        swimConnected = false;
        broadcast('status', { connected: false });
        scheduleReconnect();
    });

    session.on(solace.SessionEventCode.DISCONNECTED, () => {
        swimConnected = false;
        broadcast('status', { connected: false });
        scheduleReconnect();
    });

    session.connect();
}

module.exports = { connectToSWIM, getSnapshot, setScrapedRestrictions, setCurrentReroutes, setNasClosures, setOpsPlan, setAirportOperations, addListener, removeListener };
