const axios = require('axios');
const xml2js = require('xml2js');
const NodeCache = require('node-cache');
const cheerio = require('cheerio');

// Cache data for 120 seconds to avoid spamming FAA
const cache = new NodeCache({ stdTTL: 120 });
const OPS_PLAN_FALLBACK_URL = process.env.OPS_PLAN_URL || 'https://www.fly.faa.gov/adv/adv_otherdis?advn=93&adv_date=08252026&facId=ATCSCC&title=ATCSCC%20ADVZY%20093%20DCC%2008%2F25%2F2026%20OPERATIONS%20PLAN&titleDate=08%2F25%2F2026';
const CURRENT_REROUTES_URL = 'https://www.fly.faa.gov/current_reroutes/index';

const ADVISORY_FIELDS = [
    ['INCLUDE TRAFFIC', 'includeTraffic'],
    ['FACILITIES INCLUDED', 'facilitiesIncluded'],
    ['FLIGHT STATUS', 'flightStatus'],
    ['VALID', 'valid'],
    ['PROBABILITY OF EXTENSION', 'probabilityOfExtension'],
    ['REMARKS', 'remarks'],
    ['ASSOCIATED RESTRICTIONS', 'associatedRestrictions'],
    ['MODIFICATIONS', 'modifications'],
    ['REASON', 'reason'],
];

function parseAdvisoryDetail(rawText) {
    const lines = rawText.split('\n').map(line => line.replace(/\s+$/, ''));
    const details = {};
    let currentField = null;
    let routeStart = -1;

    for (const line of lines) {
        if (line.trim() === 'ROUTES:') {
            routeStart = lines.indexOf(line);
            break;
        }
        const field = ADVISORY_FIELDS.find(([label]) => line.startsWith(`${label}:`));
        if (field) {
            currentField = field[1];
            details[currentField] = line.slice(field[0].length + 1).trim();
        } else if (currentField && line.trim()) {
            details[currentField] += ` ${line.trim()}`;
        }
    }

    const routes = parseAdvisoryRoutes(routeStart < 0 ? [] : lines.slice(routeStart + 1));
    return { details, routes, routePlans: buildRoutePlans(routes) };
}

function buildRoutePlans(routes) {
    const directRoutes = routes.filter(route => route.section === 'DIRECT');
    if (directRoutes.length > 0) return directRoutes.map(route => ({ ...route, route: cleanRoute(route.route) }));

    const fromRoutes = routes.filter(route => route.section === 'FROM');
    const toRoutes = routes.filter(route => route.section === 'TO');
    return fromRoutes.flatMap(fromRoute => toRoutes.map(toRoute => ({
        origins: fromRoute.origins,
        destinations: toRoute.destinations,
        route: cleanRoute(`${fromRoute.route} ${toRoute.route}`),
    })));
}

function cleanRoute(route) {
    const tokens = route.replace(/[<>]/g, '').trim().split(/\s+/).filter(Boolean);
    return tokens.filter((token, index) => index === 0 || token !== tokens[index - 1]).join(' ');
}

function parseAdvisoryRoutes(lines) {
    const routes = [];
    let section = 'DIRECT';
    let previous = null;
    let inTable = false;

    for (const line of lines) {
        const clean = line.trim();
        if (!clean || /^TMI ID:/.test(clean) || /^\d{6}-\d{6}$/.test(clean) || /^\d{2}\/\d{2}\//.test(clean)) continue;
        if (clean === 'FROM:') { section = 'FROM'; inTable = false; previous = null; continue; }
        if (clean === 'TO:') { section = 'TO'; inTable = false; previous = null; continue; }
        if (/^(ORIG\s+DEST\s+ROUTE|ORIG\s+ROUTE|DEST\s+ROUTE|[- ]{4,})$/.test(clean)) {
            if (/^-{4,}/.test(clean)) inTable = true;
            continue;
        }
        if (section !== 'DIRECT' && !inTable) {
            if (/^-{4,}/.test(clean)) inTable = true;
            continue;
        }

        const originOrDestination = line.slice(0, 37).trim();
        const route = line.slice(37).trim();
        if (!route && !originOrDestination) continue;

        if (section === 'DIRECT') {
            const origin = line.slice(0, 20).trim();
            const destination = line.slice(20, 39).trim();
            const directRoute = line.slice(39).trim();
            const hasRouteEndpoint = /\bK[A-Z0-9]{2,3}\b|\bZ[A-Z0-9]{2,3}\b/.test(`${origin} ${destination}`);
            if (hasRouteEndpoint) {
                previous = { section, origins: origin ? origin.split(/\s+/) : [], destinations: destination ? destination.split(/\s+/) : [], route: directRoute };
                routes.push(previous);
            } else if (previous) {
                previous.route = `${previous.route} ${clean}`.trim();
            }
        } else if (originOrDestination) {
            previous = section === 'FROM'
                ? { section, origins: originOrDestination.split(/\s+/), destinations: [], route }
                : { section, origins: [], destinations: originOrDestination.split(/\s+/), route };
            routes.push(previous);
        } else if (previous) {
            previous.route = `${previous.route} ${clean}`.trim();
        }
    }

    return routes.filter(route => route.route || route.origins.length || route.destinations.length);
}

async function fetchCurrentReroutes() {
    const cacheKey = 'current-reroutes';
    const cachedData = cache.get(cacheKey);
    if (cachedData) return cachedData;

    try {
        const response = await axios.get(CURRENT_REROUTES_URL);
        const $ = cheerio.load(response.data);
        const rows = [];

        $('form[name^="SHOW_DETAILS"]').each((_, form) => {
            const formNode = $(form);
            const advisoryNumber = textValue(formNode.find('input[name="advzy_num"]').val());
            const summary = formNode.find('td').first().text().replace(/\s+/g, ' ').trim();
            const match = summary.match(/ATCSCC ADVZY (\d+) DCC (\d{2}\/\d{2}\/\d{4}) (ROUTE RQD|ROUTE RMD|FCA RQD)(?: \/?FL)?/i);
            const name = summary.match(/NAME:\s*(.+?)(?=\s+CONSTRAINED AREA:|\s+VALID:|$)/i)?.[1]?.trim();
            const constrainedArea = summary.match(/CONSTRAINED AREA:\s*(.+?)(?=\s+VALID:|$)/i)?.[1]?.trim();
            const validity = summary.match(/VALID:\s*(.+)$/i)?.[1]?.trim();
            if (!advisoryNumber || !match || !name) return;
            rows.push({
                advisoryNumber,
                advisoryDate: match[2],
                requirement: match[3].toUpperCase(),
                name,
                constrainedArea: constrainedArea || null,
                validity: validity || null,
                advisoryUrl: `${CURRENT_REROUTES_URL.replace(/\/index$/, '')}/showAdvisoryHandler?advzy=${encodeURIComponent(advisoryNumber)}`,
            });
        });

        const reroutes = await Promise.all(rows.map(async row => {
            const detailResponse = await axios.get(row.advisoryUrl);
            const detail$ = cheerio.load(detailResponse.data);
            const rawText = detail$('pre').first().text().replace(/\r/g, '').trim();
            const { details, routes, routePlans } = parseAdvisoryDetail(rawText);
            return {
                ...row,
                rawText,
                details,
                routes,
                routePlans,
                source: 'FAA_CURRENT_REROUTES',
                id: `reroute-${row.advisoryNumber}-${row.name}`,
                fetchedAt: new Date().toISOString(),
            };
        }));

        cache.set(cacheKey, reroutes);
        return reroutes;
    } catch (error) {
        console.error('Failed to fetch Current Reroutes', error.message);
        throw error;
    }
}

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
    const eventsResponse = await axios.get('https://nasstatus.faa.gov/api/airport-events');
    const airportEvents = Array.isArray(eventsResponse.data) ? eventsResponse.data : [];
    const status = await fetchNasStatus();
    const delayTypes = toArray(status?.AIRPORT_STATUS_INFORMATION?.Delay_type);
    const groundStopType = delayTypes.find(type => type.Name === 'Ground Stop Programs');
    const groundDelayType = delayTypes.find(type => type.Name === 'Ground Delay Programs');
    const generalDelayType = delayTypes.find(type => type.Name === 'General Arrival/Departure Delay Info');
    const groundStops = airportEvents
        .filter(event => event.groundStop)
        .map(event => ({
            airport: airportCode(event.airportId),
            aerodrome: `K${airportCode(event.airportId)}`,
            reason: textValue(event.groundStop.impactingCondition),
            endTime: textValue(event.groundStop.endTime || event.groundStop.programExpirationTime),
            probabilityOfExtension: textValue(event.groundStop.probabilityOfExtension),
            center: textValue(event.groundStop.center),
            advisoryUrl: textValue(event.groundStop.advisoryUrl),
        }))
        .filter(item => item.airport);
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
            const type = description.match(/^(STOP|GDP|GS|MINIT|MIT|EDCT|REROUTE|APREQ)\b/i)?.[1]?.toUpperCase()
                || (description.match(/\b\d+\s*MINIT\b/i) ? 'MINIT' : null)
                || (description.match(/\b\d+\s*MIT\b/i) ? 'MIT' : null)
                || 'FLOW';
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

    const stopMatch = sourceText.match(/^STOP\s+\S+\s+to\s+\S+\s+via\s+(\S+)(?:\s+SINGLE STREAM AS ONE)?(?:\s+WX:?\s*(.+))?$/i)
        || sourceText.match(/^STOP\s+(.+?)\s+via\s+(\S+)(?:\s+WX:?\s*(.+))?$/i);
    if (stopMatch) {
        const route = stopMatch.length === 3 ? stopMatch[1] : stopMatch[2];
        const weather = stopMatch.length === 3 ? stopMatch[2] : stopMatch[3];
        const cause = weather ? ` because of ${weather.toLowerCase()}` : '';
        return `Routing via ${route} is closed${cause}.`;
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
    fetchCurrentReroutes,
    fetchNasStatus,
    fetchNasClosures,
    fetchAirportOperations,
    fetchOpsPlan,
    fetchAdvisories,
    fetchRestrictions,
};
