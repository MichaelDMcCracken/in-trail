const axios = require('axios');
const xml2js = require('xml2js');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');

// Cache data for 120 seconds to avoid spamming FAA
const cache = new NodeCache({ stdTTL: 120 });
const OPS_PLAN_FALLBACK_URL = process.env.OPS_PLAN_URL || 'https://www.fly.faa.gov/adv/adv_otherdis?advn=93&adv_date=08252026&facId=ATCSCC&title=ATCSCC%20ADVZY%20093%20DCC%2008%2F25%2F2026%20OPERATIONS%20PLAN&titleDate=08%2F25%2F2026';

async function fetchNasStatus() {
    const cacheKey = 'nas-status';
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    try {
        // Fetch the XML data used by the FAA OIS/NAS Status
        const response = await axios.get('https://nasstatus.faa.gov/api/airport-status-information');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);
        
        cache.set(cacheKey, result);
        return result;
    } catch (error) {
        console.error('Failed to fetch NAS Status XML', error.message);
        throw error;
    }
}

async function fetchAdvisories() {
    const cacheKey = 'advisories';
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    try {
        // Fetch the advisories list page
        const response = await axios.get('https://www.fly.faa.gov/adv/adv_list.jsp');
        const $ = cheerio.load(response.data);
        const advisories = [];

        // Simple scraper for the table on adv_list.jsp
        $('table tr').each((i, row) => {
            if (i === 0) return; // skip header
            const cols = $(row).find('td');
            if (cols.length >= 4) {
                advisories.push({
                    number: $(cols[0]).text().trim(),
                    date: $(cols[1]).text().trim(),
                    description: $(cols[2]).text().trim(),
                    facility: $(cols[3]).text().trim(),
                });
            }
        });

        cache.set(cacheKey, advisories);
        return advisories;
    } catch (error) {
        console.error('Failed to fetch Advisories', error.message);
        throw error;
    }
}

async function fetchNasClosures() {
    const status = await fetchNasStatus();
    const airportNodes = status?.AIRPORT_STATUS_INFORMATION?.Delay_type?.Airport_Closure_List?.Airport;
    const airports = Array.isArray(airportNodes) ? airportNodes : [airportNodes].filter(Boolean);

    return airports.map(airport => {
        const code = String(airport.ARPT || '').trim().toUpperCase();
        const reason = String(airport.Reason || '').trim();
        const times = reason.match(/(\d{6})(\d{4})-(\d{6})(\d{4})/);
        return {
            id: `nas-${code}-${reason}`,
            aerodrome: code.startsWith('K') ? code : `K${code}`,
            name: 'Airport closed',
            state: 'ACTIVATED',
            startTime: times ? parseNotamTime(times[1], times[2]) : null,
            endTime: times ? parseNotamTime(times[3], times[4]) : null,
            runways: [],
            source: 'NAS_STATUS',
        };
    }).filter(closure => closure.aerodrome !== 'K');
}

async function fetchAirportOperations() {
    const status = await fetchNasStatus();
    const delayTypes = toArray(status?.AIRPORT_STATUS_INFORMATION?.Delay_type);
    const groundStopType = delayTypes.find(type => type.Name === 'Ground Stop Programs');
    const groundDelayType = delayTypes.find(type => type.Name === 'Ground Delay Programs');
    const generalDelayType = delayTypes.find(type => type.Name === 'General Arrival/Departure Delay Info');
    const groundStops = toArray(groundStopType?.Ground_Stop_List?.Program).map(program => ({
        airport: airportCode(program.ARPT),
        aerodrome: `K${airportCode(program.ARPT)}`,
        reason: textValue(program.Reason),
        endTime: textValue(program.End_Time),
    })).filter(item => item.airport);
    const groundDelayPrograms = toArray(groundDelayType?.Ground_Delay_List?.Ground_Delay).map(program => ({
        airport: airportCode(program.ARPT),
        aerodrome: `K${airportCode(program.ARPT)}`,
        reason: textValue(program.Reason),
        comments: textValue(program.Comment || program.Comments || program.Note || program.Notes),
        averageDelay: textValue(program.Avg),
        maximumDelay: textValue(program.Max),
    })).filter(item => item.airport);
    const postedDepartureDelays = toArray(generalDelayType?.Arrival_Departure_Delay_List?.Delay)
        .flatMap(delay => toArray(delay.Arrival_Departure)
            .filter(item => String(item.$?.Type || '').toLowerCase() === 'departure')
            .map(item => ({
                airport: airportCode(delay.ARPT),
                aerodrome: `K${airportCode(delay.ARPT)}`,
                reason: textValue(delay.Reason),
                minimumDelay: textValue(item.Min),
                maximumDelay: textValue(item.Max),
                trend: textValue(item.Trend),
            })));

    return { groundStops, groundDelayPrograms, departureDelays: postedDepartureDelays, fetchedAt: textValue(status?.AIRPORT_STATUS_INFORMATION?.Update_Time) };
}

function toArray(value) {
    return Array.isArray(value) ? value : value ? [value] : [];
}

function textValue(value) {
    return value == null ? '' : String(value).trim();
}

function airportCode(value) {
    return textValue(value).toUpperCase();
}

async function fetchOpsPlan() {
    const cacheKey = 'ops-plan';
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    const planUrl = await findLatestOpsPlanUrl();
    const response = await axios.get(planUrl);
    const $ = cheerio.load(response.data);
    const rawText = $('pre').first().text().replace(/\r/g, '').trim();
    const title = $('th.header').first().text().replace(/\s+/g, ' ').trim() || 'ATCSCC Operations Plan';
    const sections = parsePlanSections(rawText);
    const airportImpacts = parseAirportImpacts(sections);
    const plan = { title, rawText, sections, airportImpacts, sourceUrl: planUrl, fetchedAt: new Date().toISOString() };
    cache.set(cacheKey, plan);
    return plan;
}

async function findLatestOpsPlanUrl() {
    const today = new Date();
    for (let daysAgo = 0; daysAgo < 3; daysAgo += 1) {
        const date = new Date(today);
        date.setUTCDate(today.getUTCDate() - daysAgo);
        const dateText = date.toISOString().slice(0, 10);
        const response = await axios.get('http://www.fly.faa.gov/adv/adv_list', {
            params: {
                whichAdvisories: 'ATCSCC', advisoryCategory: 'All', date: dateText,
                airflow: 'true', ctop: 'true', gStop: 'true', gDelay: 'true', route: 'true', other: 'true',
            },
        });
        const $ = cheerio.load(response.data);
        const planLink = $('a[href*="adv_otherdis"]').filter((_, link) =>
            $(link).closest('tr').text().toUpperCase().includes('OPERATIONS PLAN')
        ).first();
        if (planLink.length) return new URL(planLink.attr('href'), 'https://www.fly.faa.gov').href;
    }
    return OPS_PLAN_FALLBACK_URL;
}

function parseAirportImpacts(sections) {
    const impactSection = sections.find(section => section.heading.startsWith('RUNWAY/EQUIPMENT'));
    const impacts = {};
    if (!impactSection) return impacts;

    for (const sourceLine of impactSection.lines) {
        const match = sourceLine.match(/^([A-Z]{3,4})\s+-\s+(.+)$/);
        if (!match) continue;
        const [, airport, detail] = match;
        const upperDetail = detail.toUpperCase();
        const endTime = parseImpactEndTime(detail);
        const kind = upperDetail.includes('TWY') || upperDetail.includes('TAXIWAY')
            ? 'TAXIWAY'
            : upperDetail.includes('RWY') || upperDetail.includes('RUNWAY')
                ? 'RUNWAY'
                : 'EQUIPMENT';
        const impact = {
            id: `ops-${airport}-${Buffer.from(sourceLine).toString('base64url')}`,
            airport,
            kind,
            detail,
            status: /LIMITED OPS/i.test(detail) ? 'LIMITED' : 'CLOSED',
            startTime: parseImpactStartTime(detail),
            endTime,
            sourceLine,
            searchableTokens: sourceLine.match(/[A-Z0-9]{2,}/g) || [],
            plainLanguage: toPlainImpactLanguage(airport, detail),
        };
        if (!impacts[airport]) impacts[airport] = [];
        impacts[airport].push(impact);
    }

    return impacts;
}

function parseImpactStartTime(detail) {
    const match = detail.match(/(?:CLOSED|LIMITED OPS)\s+(\d{2}\/\d{2}\/\d{2}) (\d{4})/i);
    return match ? parseShortDateTime(match[1], match[2]) : null;
}

function parseImpactEndTime(detail) {
    const match = detail.match(/(?:UNTIL|TO)\s+(\d{2}\/\d{2}\/\d{2})\s+(?:AT\s+)?(\d{4})Z?/i);
    return match ? parseShortDateTime(match[1], match[2]) : null;
}

function parseShortDateTime(dateText, timeText) {
    const [month, day, year] = dateText.split('/');
    return `20${year}-${month}-${day}T${timeText.slice(0, 2)}:${timeText.slice(2)}:00Z`;
}

function toPlainImpactLanguage(airport, detail) {
    const normalized = detail
        .replace(/\bTWY\b/gi, 'taxiway')
        .replace(/\bRWY\b/gi, 'runway')
        .replace(/\bCLOSED\b/gi, 'closed')
        .replace(/\bCLSD\b/gi, 'closed')
        .replace(/\bLIMITED OPS\b/gi, 'limited operations')
        .replace(/\bW\//gi, 'with ')
        .replace(/\bVARYING TIMES\b/gi, 'varying times')
        .replace(/\bCLOSURES\b/gi, 'closures')
        .replace(/\bHIGH SPEED TAXIWAY\b/gi, 'high-speed taxiway')
        .replace(/\s+/g, ' ')
        .trim();
    const sentence = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return `${airport} airport: ${sentence}.`;
}

function parsePlanSections(rawText) {
    const lines = rawText.split('\n').map(line => line.trimEnd());
    const sections = [];
    let current = null;

    for (const line of lines) {
        const clean = line.trim();
        if (!clean || /^_+$/.test(clean)) continue;
        const isHeading = /^[A-Z][A-Z0-9 /()&'-]{3,}:\s*$/i.test(clean);
        if (isHeading) {
            current = { heading: clean.replace(/:\s*$/, ''), lines: [] };
            sections.push(current);
        } else if (current) {
            current.lines.push(clean);
        }
    }

    return sections.filter(section => section.lines.length > 0);
}

function parseNotamTime(dateText, timeText) {
    const year = 2000 + Number(dateText.slice(0, 2));
    const month = dateText.slice(2, 4);
    const day = dateText.slice(4, 6);
    return `${year}-${month}-${day}T${timeText.slice(0, 2)}:${timeText.slice(2)}:00Z`;
}

async function fetchRestrictions() {
    const cacheKey = 'restrictions';
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    try {
        const response = await axios.get('https://www.fly.faa.gov/restrictions/restrictions?reqFac=ALL&provFac=ALL');
        const $ = cheerio.load(response.data);
        const restrictions = [];

        $('table tr').each((index, row) => {
            if (index === 0) return;
            const columns = $(row).find('td').map((_, cell) => $(cell).text().trim()).get();
            if (columns.length < 5) return;
            if (columns[0] === 'REQUESTING' && columns[1] === 'PROVIDING') return;

            const [requestingFacility, providingFacility, description, startText, endText] = columns;
            if (/^APREQ\b/i.test(description)) return;
            if (isOperatorMessage(description) || isExcludedOperationalMessage(description)) return;
            const type = description.match(/^(STOP|GDP|GS|MINIT|MIT|EDCT|REROUTE|APREQ)\b/i)?.[1]?.toUpperCase() || 'FLOW';
            const id = [requestingFacility, providingFacility, description, startText, endText].join('|');

            restrictions.push({
                id: `faa-${Buffer.from(id).toString('base64url')}`,
                source: 'FAA_RESTRICTIONS',
                aerodrome: requestingFacility,
                requestingFacility,
                providingFacility,
                name: description,
                plainLanguage: toPlainLanguage(description),
                type,
                status: 'ACTIVE',
                startTime: parseFaaTime(startText),
                endTime: parseFaaTime(endText),
                untilFurtherNotice: !endText,
                nasElement: description,
                controlledElement: null,
                milesInTrail: 0,
                minutesInTrail: 0,
                reason: null,
                restriction: null,
            });
        });

        cache.set(cacheKey, restrictions);
        return restrictions;
    } catch (error) {
        console.error('Failed to fetch FAA Restrictions', error.message);
        throw error;
    }
}

function isOperatorMessage(description) {
    return /\bPLEASE\s+SCHEDULE\b/i.test(description)
        || /\bDO\s+NOT\s+DELAY\s+AIRBORNE\s+FLTS\b/i.test(description);
}

function isExcludedOperationalMessage(description) {
    return /\bTBM\b|\bMETERING\b|\bSCHEDULE\b/i.test(description);
}

function toPlainLanguage(description) {
    const sourceText = description
        .replace(/\s+[A-Z0-9/]+:[A-Z0-9/,]+\s*$/, '')
        .replace(/\b\d{4}-\d{4}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const stopMatch = sourceText.match(/^STOP\s+(.+?)\s+via\s+(\S+)(?:\s+WX:(.+))?$/i);
    if (stopMatch) {
        const cause = stopMatch[3] ? ` because of ${stopMatch[3].toLowerCase()}` : '';
        return `Routing via ${stopMatch[2]} is closed${cause}.`;
    }

    const scheduleMatch = sourceText.match(/^SCHEDULE DEPTS TO (\S+) INTO TBFM - DO NOT DELAY AIRBORNE FLTS$/i);
    if (scheduleMatch) {
        return `Schedule departures to ${scheduleMatch[1]} in the TBFM timeline; do not delay flights already airborne.`;
    }

    const requestScheduleMatch = sourceText.match(/^PLEASE SCHEDULE (.+?)\. THANK YOU$/i);
    if (requestScheduleMatch) {
        return `Schedule ${requestScheduleMatch[1].toLowerCase()}.`;
    }

    return sourceText
        .replace(/\b(\d+)MIT\b/gi, '$1-mile in-trail')
        .replace(/\b(\d+)\s+MIT\b/gi, '$1-mile in-trail')
        .replace(/\bDEPTS\b/gi, 'departures')
        .replace(/\bARRIVALS\b/gi, 'arrivals')
        .replace(/\bJETS\b/gi, 'jets')
        .replace(/\bSPD:\s*(\d+)\b/gi, 'speed $1 knots')
        .replace(/\bEXCL:\s*/gi, 'except ')
        .replace(/\bFLOW\b/gi, 'flow')
        .replace(/\s*:\s*/g, ': ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^./, character => character.toUpperCase()) + '.';
}

function parseFaaTime(value) {
    if (!value) return null;
    const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{4})$/);
    if (!match) return null;
    const [, month, day, year, hhmm] = match;
    return `${year}-${month}-${day}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`;
}

module.exports = {
    fetchNasStatus,
    fetchNasClosures,
    fetchAirportOperations,
    fetchOpsPlan,
    fetchAdvisories,
    fetchRestrictions,
};
