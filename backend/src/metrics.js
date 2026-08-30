// Lightweight production instrumentation for WebSocket traffic.
// Records snapshot sizes, broadcast counts, client connections, and bandwidth
// estimates. Does NOT log actual snapshot contents.

const stats = {
    // Snapshot size tracking (bytes of serialized JSON)
    snapshotSizeMin: Infinity,
    snapshotSizeMax: 0,
    snapshotSizeTotalBytes: 0,

    // Broadcasts sent (snapshot changed, actually delivered to clients)
    broadcastsSent: 0,
    // Broadcasts skipped because snapshot was unchanged
    broadcastsSkipped: 0,

    // Breakdown by trigger source
    broadcastsByTrigger: {
        faa_refresh: 0,
        swim_message: 0,
        other: 0,
    },

    // Total bytes sent across all clients for all broadcasts
    // (broadcastBytes × clientCount at time of broadcast)
    totalBytesSentToClients: 0,

    // WebSocket connection lifecycle
    connectionsOpened: 0,
    connectionsClosed: 0,

    // Rolling hourly window (reset every hour by the summary log)
    hourlyBroadcastsSent: 0,
    hourlyBroadcastsSkipped: 0,
    hourlyBytesSentToClients: 0,
    hourWindowStart: Date.now(),
};

/**
 * Record a snapshot broadcast that was actually sent.
 * @param {number} snapshotBytes - Serialized JSON byte length of the snapshot.
 * @param {number} clientCount   - Number of connected WebSocket clients.
 * @param {'faa_refresh'|'swim_message'|'other'} trigger
 */
function recordBroadcastSent(snapshotBytes, clientCount, trigger) {
    stats.broadcastsSent++;
    stats.hourlyBroadcastsSent++;

    if (snapshotBytes < stats.snapshotSizeMin) stats.snapshotSizeMin = snapshotBytes;
    if (snapshotBytes > stats.snapshotSizeMax) stats.snapshotSizeMax = snapshotBytes;
    stats.snapshotSizeTotalBytes += snapshotBytes;

    const bytesThisBroadcast = snapshotBytes * clientCount;
    stats.totalBytesSentToClients += bytesThisBroadcast;
    stats.hourlyBytesSentToClients += bytesThisBroadcast;

    const key = Object.prototype.hasOwnProperty.call(stats.broadcastsByTrigger, trigger)
        ? trigger
        : 'other';
    stats.broadcastsByTrigger[key]++;

    console.log(
        `[ws-metrics] broadcast sent | bytes=${snapshotBytes} clients=${clientCount} trigger=${trigger} ` +
        `total_sent=${stats.broadcastsSent} total_skipped=${stats.broadcastsSkipped}`
    );
}

/** Record a broadcast that was skipped because the snapshot was unchanged. */
function recordBroadcastSkipped() {
    stats.broadcastsSkipped++;
    stats.hourlyBroadcastsSkipped++;
}

/** Record a new WebSocket client connection. */
function recordConnectionOpened() {
    stats.connectionsOpened++;
    console.log(`[ws-metrics] client connected | total_open=${stats.connectionsOpened - stats.connectionsClosed}`);
}

/** Record a WebSocket client disconnection. */
function recordConnectionClosed() {
    stats.connectionsClosed++;
    console.log(`[ws-metrics] client disconnected | total_open=${stats.connectionsOpened - stats.connectionsClosed}`);
}

/** Return a snapshot of current metrics (safe to expose via REST). */
function getMetrics() {
    const sent = stats.broadcastsSent;
    const avgBytes = sent > 0 ? Math.round(stats.snapshotSizeTotalBytes / sent) : 0;
    const openClients = stats.connectionsOpened - stats.connectionsClosed;
    const hourElapsedMs = Date.now() - stats.hourWindowStart;
    const hourElapsedHours = hourElapsedMs / (60 * 60 * 1000);
    const broadcastsPerHour = hourElapsedHours > 0
        ? Math.round(stats.hourlyBroadcastsSent / hourElapsedHours)
        : 0;
    const bytesPerClientPerHour = (openClients > 0 && hourElapsedHours > 0)
        ? Math.round(stats.hourlyBytesSentToClients / openClients / hourElapsedHours)
        : 0;

    return {
        snapshot: {
            minBytes: stats.snapshotSizeMin === Infinity ? null : stats.snapshotSizeMin,
            maxBytes: stats.snapshotSizeMax || null,
            avgBytes,
        },
        broadcasts: {
            sent: stats.broadcastsSent,
            skipped: stats.broadcastsSkipped,
            byTrigger: { ...stats.broadcastsByTrigger },
        },
        bandwidth: {
            totalBytesSentToClients: stats.totalBytesSentToClients,
            broadcastsPerHour,
            bytesPerClientPerHour,
            estimatedMonthlyBytesByClients: estimateMonthly(broadcastsPerHour, avgBytes),
        },
        connections: {
            opened: stats.connectionsOpened,
            closed: stats.connectionsClosed,
            currentlyOpen: openClients,
        },
        hourWindow: {
            startedAt: new Date(stats.hourWindowStart).toISOString(),
            broadcastsSent: stats.hourlyBroadcastsSent,
            broadcastsSkipped: stats.hourlyBroadcastsSkipped,
            bytesSentToClients: stats.hourlyBytesSentToClients,
        },
    };
}

function estimateMonthly(broadcastsPerHour, avgBytes) {
    const hoursPerMonth = 24 * 30;
    const broadcastsPerMonth = broadcastsPerHour * hoursPerMonth;
    const bytesPerBroadcast = avgBytes;
    const clients = [1, 10, 25, 50, 100];
    const result = {};
    for (const n of clients) {
        result[`${n}_clients`] = broadcastsPerMonth * bytesPerBroadcast * n;
    }
    return result;
}

/** Log a human-readable hourly summary and reset the hourly counters. */
function logHourlySummary() {
    const m = getMetrics();
    console.log(
        `[ws-metrics] HOURLY SUMMARY | ` +
        `broadcasts_sent=${m.hourWindow.broadcastsSent} skipped=${m.hourWindow.broadcastsSkipped} ` +
        `by_trigger=${JSON.stringify(m.broadcasts.byTrigger)} ` +
        `snapshot_avg=${m.snapshot.avgBytes}B min=${m.snapshot.minBytes}B max=${m.snapshot.maxBytes}B ` +
        `clients_now=${m.connections.currentlyOpen} ` +
        `bytes_to_clients_this_hour=${m.hourWindow.bytesSentToClients} ` +
        `est_monthly_bytes_1client=${m.bandwidth.estimatedMonthlyBytesByClients['1_clients']} ` +
        `est_monthly_bytes_10clients=${m.bandwidth.estimatedMonthlyBytesByClients['10_clients']}`
    );
    // Reset hourly counters
    stats.hourlyBroadcastsSent = 0;
    stats.hourlyBroadcastsSkipped = 0;
    stats.hourlyBytesSentToClients = 0;
    stats.hourWindowStart = Date.now();
}

module.exports = { recordBroadcastSent, recordBroadcastSkipped, recordConnectionOpened, recordConnectionClosed, getMetrics, logHourlySummary };
