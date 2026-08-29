import { useState, useEffect, useRef, useMemo } from 'react'
import { ARTCC_NAMES, TRACON_NAMES, FACILITY_NAMES, CONTROL_FACILITY_NAMES } from './facilityNames'
import Guide from './Guide'

// ── helpers ─────────────────────────────────────────────────────────────────

function fmtTime(iso) {
    if (!iso) return null
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', {
        timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }) + 'Z'
}

function fmtGroundStopEnd(iso) {
    if (!iso) return 'end time not posted'
    const date = new Date(iso)
    const format = timeZone => date.toLocaleTimeString('en-US', {
        timeZone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    })
    return `${format('America/New_York')} / ${format('UTC')}`
}

function fmtRelative(iso) {
    if (!iso) return null
    const diff = new Date(iso) - Date.now()
    const abs = Math.abs(diff)
    const mins = Math.floor(abs / 60000)
    const hrs = Math.floor(mins / 60)
    const m = mins % 60
    if (diff < 0) return hrs > 0 ? `-${hrs}h${m}m` : `-${mins}m`
    return hrs > 0 ? `+${hrs}h${m}m` : `+${mins}m`
}

const ALL_CLEAR_QUIPS = [
    'clear skies ahead',
    'smooth sailing out there',
    'nothing but blue skies',
    'all quiet on the airspace front',
]

const AIRPORT_ARTCCS = {
    KADW: ['ZDC'], KATL: ['ZTL'], KBOS: ['ZBW'], KBWI: ['ZDC'], KCAE: ['ZJX'],
    KCHO: ['ZDC'], KCHS: ['ZJX'], KDCA: ['ZDC'], KDTW: ['ZOB'], KEWR: ['ZNY'],
    KFLL: ['ZMA'], KFLO: ['ZJX'], KGAI: ['ZDC'], KGSO: ['ZTL'], KGRR: ['ZOB'],
    KHEF: ['ZDC'], KHXD: ['ZJX'], KHPN: ['ZNY'], KIAD: ['ZDC'], KILM: ['ZJX'],
    KJFK: ['ZNY'], KJZI: ['ZJX'], KLAS: ['ZLA'], KLGA: ['ZNY'], KMCO: ['ZJX'],
    KMMU: ['ZNY'], KMYR: ['ZJX'], KORD: ['ZAU'], KORF: ['ZDC'], KRDU: ['ZDC'],
    KRIC: ['ZDC'], KROA: ['ZDC'], KRSW: ['ZMA'], KSAV: ['ZJX'], KTEB: ['ZNY'],
}

function routeContainsSearchToken(route, token) {
    const endpoints = [...(route.origins || []), ...(route.destinations || [])]
    const exclusions = [...(route.originExclusions || []), ...(route.destinationExclusions || [])]
    if (exclusions.some(code => code.includes(token) || `K${code}` === token)) return false
    if (endpoints.some(code => code.includes(token))) return true
    return AIRPORT_ARTCCS[token]?.some(center => route.origins?.includes(center)) || false
}

function rerouteTypeLabel(requirement) {
    if (requirement === 'ROUTE RQD') return 'Required route'
    if (requirement === 'ROUTE RMD') return 'Recommended route'
    if (requirement === 'FCA RQD') return 'Flow constrained area'
    return 'Route advisory'
}

// Resolve a searched code (e.g. "ATL" or "KATL") to a friendly airport name, if known.
function lookupAirportName(query) {
    if (!/^[A-Z]{3,4}$/.test(query)) return null
    const icao = query.length === 4 ? query.slice(1) : query
    const name = FACILITY_NAMES[icao]
    return name ? name.replace(/ (Tower|TRACAB)$/, '') : null
}

function fmtRemaining(iso) {
    if (!iso) return null
    const diff = new Date(iso) - Date.now()
    const mins = Math.max(0, Math.floor(Math.abs(diff) / 60000))
    const hrs = Math.floor(mins / 60)
    const remainingMins = mins % 60
    if (mins >= 24 * 60) {
        const days = Math.floor(mins / (24 * 60))
        const months = Math.floor(days / 30)
        const remainingDays = days % 30
        if (months > 0) return `${months} mo${months === 1 ? '' : 's'}${remainingDays ? ` ${remainingDays} day${remainingDays === 1 ? '' : 's'}` : ''} remaining`
        return `${days} day${days === 1 ? '' : 's'} remaining`
    }
    if (hrs > 0) return `${hrs} hr${hrs === 1 ? '' : 's'} ${remainingMins} min remaining`
    return `${remainingMins} min remaining`
}

function fmtEndTime(iso) {
    if (!iso) return null
    const diff = new Date(iso) - Date.now()
    if (diff < 24 * 60 * 60 * 1000) return fmtTime(iso)
    const date = new Date(iso)
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: '2-digit' }) + ` · ${fmtTime(iso)}`
}

// ── Type groupings ───────────────────────────────────────────────────────────

const GROUPS = [
    {
        key: 'stop',
        label: 'Route Closures',
        icon: '🛑',
        color: 'red',
        matches: tmi => tmi.type === 'STOP',
    },
    {
        key: 'trail',
        label: 'In-Trail Restrictions',
        icon: '↔',
        color: 'yellow',
        types: ['MINIT', 'MIT'],
    },
    {
        key: 'edct',
        label: 'EDCTs',
        icon: '🕐',
        color: 'purple',
        types: ['EDCT'],
    },
    {
        key: 'reroute',
        label: 'Reroutes',
        icon: '↩',
        color: 'teal',
        types: ['REROUTE'],
    },
    {
        key: 'other',
        label: 'Other Restrictions',
        icon: '≋',
        color: 'blue',
        types: ['FLOW'],
    },
]

const GROUP_STYLES = {
    red:    { header: 'bg-red-950 border-red-800',    badge: 'bg-red-500 text-white',    row: 'border-red-900/40' },
    orange: { header: 'bg-orange-950 border-orange-800', badge: 'bg-orange-500 text-white', row: 'border-orange-900/40' },
    yellow: { header: 'bg-yellow-950 border-yellow-800', badge: 'bg-yellow-400 text-black', row: 'border-yellow-900/40' },
    blue:   { header: 'bg-blue-950 border-blue-800',  badge: 'bg-blue-500 text-white',   row: 'border-blue-900/40' },
    purple: { header: 'bg-purple-950 border-purple-800', badge: 'bg-purple-500 text-white', row: 'border-purple-900/40' },
    teal:   { header: 'bg-teal-950 border-teal-800',  badge: 'bg-teal-500 text-white',   row: 'border-teal-900/40' },
}

const DISPLAYED_RESTRICTION_TYPES = new Set(['STOP', 'MIT', 'MINIT'])

// ── Plain-English description ────────────────────────────────────────────────

function facilityCodes(facility) {
    return facility
        .replace(/(?:Â£|£)/g, '|')
    .split(/[|/]/)
    .map(segment => segment.trim())
        .filter(segment => segment && !/^\d+$/.test(segment))
}

function formatFacility(facility, compact = false) {
    const codes = facilityCodes(facility)
    if (compact && codes.length > 4) {
        const traconCount = codes.filter(code => TRACON_NAMES[code]).length
        const artccCount = codes.filter(code => ARTCC_NAMES[code]).length
        if (artccCount === codes.length) return `${codes.length} ARTCCs`
        if (traconCount + artccCount === codes.length) return `${codes.length} facilities`
    }
    return codes
        .map(code => FACILITY_NAMES[code] ? `${FACILITY_NAMES[code]} (${code})` : code)
        .join(' / ')
}

function formatRoute(route) {
    return route
        .split('/')
        .map(value => value.replace(/\*/g, '').trim())
        .filter(Boolean)
        .join(' / ')
}

function describe(tmi) {
    if (tmi.source === 'FAA_RESTRICTIONS') return tmi.plainLanguage || tmi.name
    const isGroundStop = ['STOP', 'GS'].includes(tmi.type)
    const from = tmi.providingFacility ? `from ${formatFacility(tmi.providingFacility, isGroundStop)}` : ''
    const rawTarget = tmi.type === 'MIT' && !tmi.milesInTrail && !tmi.minutesInTrail && tmi.name
        ? tmi.name.replace(/\s+\d+\s*(?:MIT|MINIT)\s*$/i, '').trim()
        : tmi.controlledElement || tmi.nasElement || tmi.aerodrome
    const target = rawTarget.includes('/') ? formatRoute(rawTarget) : rawTarget.replace(/\*/g, '')
    const scope = (tmi.scope || tmi.restriction || (tmi.type === 'GDP' ? 'ARRIVALS' : isGroundStop ? 'DEPARTURES' : 'TRAFFIC')).toUpperCase()
    const flow = scope === 'ARRIVALS' ? 'arrivals' : scope === 'DEPARTURES' ? 'departures' : 'traffic'
    const reason = tmi.reason ? ` ${summarizeTmiReason(tmi.reason)}.` : ''

    switch (tmi.type) {
        case 'STOP':
        case 'GS':
            return `Ground stop on ${flow} to ${target} ${from}.${reason}`
        case 'GDP':
            return `Ground delay program for ${flow} into ${target} ${from}.${reason}`
        case 'MINIT':
            return `${tmi.minutesInTrail}-minute in-trail at ${target}${tmi.milesInTrail ? ` (${tmi.milesInTrail} nm)` : ''} for ${flow} ${from}.${reason}`
        case 'MIT':
            return `${tmi.milesInTrail}-mile in-trail at ${target} for ${flow} ${from}.${reason}`
        case 'APREQ':
            return `Approval required for ${flow} to ${target} ${from}`
        case 'EDCT':
            return `Expect departure clearance time for ${flow} to ${target} ${from}`
        case 'REROUTE':
            return `Reroute affecting ${target} ${from}`
        default:
            return `${tmi.type} on ${target} ${from}`
    }
}

function summarizeTmiReason(reason) {
    const value = reason.replace(/\s+/g, ' ').trim().replace(/^(OTHER\s+)+/i, '')
    if (/\bSTAFFING\b/i.test(value)) return 'Due to staffing'
    if (/^MILITARY OPS$/i.test(value)) return 'Due to military operations'
    const weatherMatch = value.match(/^WX\s*:\s*(.+)$/i) || value.match(/^WX\s+(.+)$/i)
    if (weatherMatch) return `Due to ${weatherMatch[1].toLowerCase()}`
    const volumeMatch = value.match(/^VOL\s*:\s*(.+)$/i) || value.match(/^VOL\s+(.+)$/i)
    if (volumeMatch && /^VOLUME$/i.test(volumeMatch[1].trim())) return 'Due to volume'
    if (volumeMatch) return `Due to volume: ${volumeMatch[1].replace(/[-_]+/g, ' ').toLowerCase()}`
    const reasonMatch = value.match(/^REASON\s+(.+)$/i)
    if (reasonMatch) return `Due to ${reasonMatch[1].toLowerCase()}`
    return `Due to ${value.replace(/[-_]+/g, ' ').toLowerCase()}`
}

const COMMON_DESCRIPTION_WORDS = new Set([
    'A', 'ACTIVE', 'AIRBORNE', 'AN', 'AND', 'APPROVAL', 'ARRIVALS', 'AS', 'AT', 'BEHIND',
    'BECAUSE', 'BY', 'CLOSED', 'CLOSURE', 'CLEARANCE', 'DEPARTURES', 'EAST', 'EFFECT',
    'EXCEPT', 'FLOW', 'FOR', 'FROM', 'GROUND', 'IN', 'INTO', 'JET', 'JETS', 'MILE',
    'LTFC', 'MILES', 'MINUTE', 'MINUTES', 'NORM', 'NORTH', 'OF', 'ON', 'ONE', 'PER', 'PROGRAM', 'REQUIRED',
    'ROUTE', 'SCHEDULE', 'SCHEDULING', 'SOUTH', 'SPEED', 'STOP', 'THE', 'TO', 'TRAFFIC',
    'OTHER', 'RALT', 'UNTIL', 'VIA', 'WEST', 'WITH', 'VOLUME',
])

const AVIATION_TERM_LABELS = {
    RRTE: 'Reroute',
}

function locationLabel(code) {
    return CONTROL_FACILITY_NAMES[code]
    ? <span className="center-label"><strong>{CONTROL_FACILITY_NAMES[code]}</strong><small>{code}</small></span>
        : code.replace(/^K/, '')
}

function highlightAviationTerms(text) {
    const displayText = text
        .replace(/\bRALT\b\s*/gi, '')
        .replace(/\bALT:\s*A(?:OA|OB)(?:\/A(?:OA|OB))?\s*(?:FL)?\d{2,3}\b\s*/gi, '')
        .replace(/\bRWY:\s*DISABLED AIRCRAFT\b/gi, 'a disabled aircraft on the runway')
        .replace(/\bWX:\s*([A-Z])?/gi, (_, firstLetter) => firstLetter ? `Due to ${firstLetter.toLowerCase()}` : 'Due to ')
        .replace(/\s*,?\s*\b(?:EXCL|EXCEPT):\s*NONE\b\.?/gi, '.')
        .replace(/\s*,?\s*\bexcept\s+NONE\b\.?/gi, '.')
        .replace(/^STOP\s+(.+?)\s+via\s+(\S+)\s+except\s+(.+?)\s+(?:OTHER:\s+\S+\s+)?STAFFING\.?$/i, (_, facilities, route, exceptions) => {
            const cleanFacilities = facilities.replace(/\s*,\s*/g, ', ')
            const cleanExceptions = exceptions.replace(/\s*\/\s*/g, ', ').replace(/,\s*$/, '').trim()
            const routeLabel = /^ARS$/i.test(route) ? 'the ARs' : route
            return `Routing from ${cleanFacilities} via ${routeLabel} closed, except ${cleanExceptions}, due to staffing.`
        })
        .replace(/^STOP\s+(.+?)\s+via\s+(\S+)(?:\s+(?:WX:?\s*|due to\s+)(.+))?\.?$/i, (_, facilities, route, weather) => {
            const cleanFacilities = facilities.replace(/\s*,\s*/g, ', ')
            const cleanWeather = weather?.replace(/[.]+$/, '').trim()
            const routeLabel = /^ARS$/i.test(route) ? 'the ARs' : route
            return `Routing from ${cleanFacilities} via ${routeLabel} closed${cleanWeather ? ` because of ${cleanWeather.toLowerCase()}` : ''}.`
        })
        .replace(/\s+/g, ' ')
        .trim()

    return displayText.split(/([A-Z][A-Z0-9]{1,7}(?:s)?)/g).map((part, index) => {
        const aviationPart = part === 'ARs' ? 'ARS' : part
        const isRoute = /^[A-Z]{1,6}\d{1,4}[A-Z]?$/.test(aviationPart)
        const centerName = CONTROL_FACILITY_NAMES[aviationPart]
        const isNamedFacility = FACILITY_NAMES[aviationPart]
        const isAirportOrFix = /^[A-Z]{3,5}$/.test(aviationPart)
            && !COMMON_DESCRIPTION_WORDS.has(aviationPart)
        const isIdentifier = isRoute || isAirportOrFix || isNamedFacility
        const label = AVIATION_TERM_LABELS[aviationPart]
        if (centerName) {
            return <strong
                className="center-term"
                key={`${part}-${index}`}
                title={centerName}
                data-tooltip={centerName}
                tabIndex="0"
                aria-label={`${part}, ${centerName}`}
            >{part}</strong>
        }
        return isIdentifier
            ? label
                ? label
                : <strong className="aviation-term" key={`${part}-${index}`}>{part}</strong>
            : part
    })
}

function rerouteEndpointCodes(codes, fallback) {
    if (!codes?.length) return fallback
    return codes.map((code, index) => (
        <span key={`${code}-${index}`}>
            {index > 0 && ' '}
            {CONTROL_FACILITY_NAMES[code]
                ? <strong
                    className="reroute-facility"
                    title={CONTROL_FACILITY_NAMES[code]}
                    data-tooltip={CONTROL_FACILITY_NAMES[code]}
                    tabIndex="0"
                    aria-label={`${code}, ${CONTROL_FACILITY_NAMES[code]}`}
                >{code}</strong>
                : code}
        </span>
    ))
}

function formatRerouteEndpoints(codes, exclusions, fallback) {
    const endpoints = rerouteEndpointCodes(codes, fallback)
    if (!exclusions?.length) return endpoints
    return <>{endpoints} <small className="reroute-exceptions">(except {exclusions.join(', ')})</small></>
}

// ── TMI Row ──────────────────────────────────────────────────────────────────

function TMIRow({ tmi, style }) {
    const isProposed = tmi.status === 'PROPOSED'
    const hasTime = tmi.untilFurtherNotice || tmi.startTime || tmi.endTime

    return (
        <div className={`restriction-row border-b last:border-b-0 ${style.row}`}>
            {/* Status pill */}
            <div className="restriction-status">
                {isProposed
                    ? <span className="status-pill status-pill--proposed">PROPOSED</span>
                    : <span className="status-pill status-pill--active">{tmi.status || 'ACTIVE'}</span>
                }
            </div>

            {/* Airport tag */}
            <span className="airport-code">{locationLabel(tmi.aerodrome)}</span>

            {/* Description */}
            <span className="row-description">{highlightAviationTerms(describe(tmi))}</span>

            {/* Time */}
            {hasTime && (
                <TimeBubble tmi={tmi} />
            )}

            {/* Reason chip */}
                {tmi.reason && !['STOP', 'GS', 'MIT', 'MINIT'].includes(tmi.type) && (
                <span className="reason-chip">
                    {tmi.reason}
                </span>
            )}
        </div>
    )
}

function TimeBubble({ tmi }) {
    return (
        <span className="time-bubble">
            {tmi.untilFurtherNotice
                ? <span className="time-bubble__ufn">UNTIL FURTHER NOTICE</span>
                : <>
                    {tmi.startTime && <span style={{ gridColumn: 1 }}><small>START</small><strong>{fmtTime(tmi.startTime)}</strong></span>}
                    {tmi.endTime && <span style={{ gridColumn: 2 }}><small>END</small><strong>{fmtEndTime(tmi.endTime)}</strong></span>}
                    {tmi.endTime && <em style={{ gridColumn: 3 }}>{fmtRemaining(tmi.endTime)}</em>}
                </>
            }
        </span>
    )
}

function summarizeDelayReason(reason) {
    const value = (reason || '').trim()
    if (!value) return 'reason not posted'
    if (/\bSTAFFING\b/i.test(value)) return 'Due to staffing'
    if (/^TM Initiatives:(?:SWAP|MIT):WX$/i.test(value)) return 'Due to weather'
    const weatherMatch = value.match(/^WX:(.+)$/i)
    if (weatherMatch) return `Due to ${weatherMatch[1].trim().toLowerCase()}`
    if (/^RWY:\s*DISABLED AIRCRAFT$/i.test(value)) return 'Due to a disabled aircraft on the runway'
    if (/^RWY:CONSTRUCTION$/i.test(value)) return 'Due to runway construction'
    if (/^VOL:\s*VOLUME$/i.test(value)) return 'Due to volume'
    return `Due to ${value.replace(/^TM Initiatives:/i, '').trim().toLowerCase()}`
}

function scrollSectionToTop(sectionRef) {
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function ScrollToTopAction({ onClick }) {
    return (
        <div className="scroll-top-action">
            <button className="scroll-top-button" type="button" onClick={onClick} aria-label="Scroll to top of this section">
                ↑ Back to top
            </button>
        </div>
    )
}

function AirportDelays({ operations, autoExpand, query }) {
    const [collapsed, setCollapsed] = useState(true)
    const sectionRef = useRef(null)

    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    if (!operations) return null
    const airportTokens = query.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean)
    const matchesAirport = item => airportTokens.length === 0 || airportTokens.some(token => {
        const iataCode = token.length === 4 && /^[KC]/.test(token) ? token.slice(1) : token
        return item.airport.includes(token) || item.airport.includes(iataCode) || item.aerodrome.includes(token)
    })
    const groundStops = operations.groundStops.filter(matchesAirport)
    const groundDelayPrograms = operations.groundDelayPrograms.filter(matchesAirport)
    const departureDelays = operations.departureDelays.filter(matchesAirport)
    const hasData = groundStops.length > 0 || groundDelayPrograms.length > 0 || departureDelays.length > 0
    if (!hasData) return null

    return (
        <section ref={sectionRef} className="group-card airport-operations-card">
            <button className="group-card__header airport-operations-card__header" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title"><span className="group-card__icon">◉</span><span>Airport Delays</span></h2>
                <span className="airport-operations-card__meta">FAA NAS status · posted live data</span>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="airport-operations">
                <div className="airport-operations__grid">
                {groundStops.length > 0 && (
                    <div className="airport-operations__group airport-operations__group--stop">
                        <h3>Arrival ground stops <strong>{groundStops.length}</strong></h3>
                        {groundStops.map(item => (
                            <div className="airport-operation" key={`stop-${item.airport}`}>
                                <strong>{item.airport}</strong><span>Due to {item.reason ? item.reason.toLowerCase() : 'reason not posted'}</span>
                                <div className="airport-operation__metrics">
                                    <em>Until {fmtGroundStopEnd(item.endTime)}</em>
                                    <em className="airport-operation__metric--extension">Probability of extension {item.probabilityOfExtension || 'not posted'}</em>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {groundDelayPrograms.length > 0 && (
                    <div className="airport-operations__group airport-operations__group--gdp">
                        <h3>Ground delay programs <strong>{groundDelayPrograms.length}</strong></h3>
                        {groundDelayPrograms.map(item => (
                            <div className="airport-operation" key={`gdp-${item.airport}`}>
                                <strong>{item.airport}</strong><span>{summarizeDelayReason(item.reason)}{item.comments ? ` · ${item.comments}` : ''}</span>
                                <div className="airport-operation__metrics"><span className="airport-operation__metric--average">avg {item.averageDelay}</span><span className="airport-operation__metric--maximum">max {item.maximumDelay}</span></div>
                            </div>
                        ))}
                    </div>
                )}
                {departureDelays.length > 0 && (
                    <div className="airport-operations__group airport-operations__group--departure">
                        <h3>Posted departure delays <strong>{departureDelays.length}</strong></h3>
                        {departureDelays.map(item => (
                            <div className="airport-operation" key={`departure-${item.airport}`}>
                                <strong>{item.airport}</strong><span>{summarizeDelayReason(item.reason)}</span>
                                <div className="airport-operation__metrics"><span className="airport-operation__metric--range">{item.minimumDelay} to {item.maximumDelay}</span><em className={`airport-operation__metric--trend airport-operation__metric--trend-${item.trend.toLowerCase()}`}>Delays {item.trend.toLowerCase()}</em></div>
                            </div>
                        ))}
                    </div>
                )}
                </div>
                <ScrollToTopAction onClick={() => scrollSectionToTop(sectionRef)} />
            </div>}
        </section>
    )
}

function CurrentReroutes({ reroutes, autoExpand, query }) {
    const [collapsed, setCollapsed] = useState(true)
    const sectionRef = useRef(null)

    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    const tokens = query.replace(/,/g, ' ').trim().toUpperCase().split(/\s+/).filter(Boolean)
    const routeMatches = reroutes.flatMap(reroute => (reroute.routePlans || [])
        .filter(route => tokens.length === 0 || tokens.some(token => routeContainsSearchToken(route, token)))
        .map(route => ({ reroute, route })))
    const visibleReroutes = tokens.length > 0
        ? reroutes.filter(reroute => routeMatches.some(match => match.reroute.id === reroute.id))
        : reroutes

    const requirementCounts = reroutes.reduce((counts, reroute) => {
        const requirement = reroute.requirement || ''
        if (requirement === 'ROUTE RQD') counts.required += 1
        else if (requirement === 'ROUTE RMD') counts.recommended += 1
        else if (requirement === 'FCA RQD') counts.fca += 1
        return counts
    }, { required: 0, recommended: 0, fca: 0 })

    const requirementSegments = [
        requirementCounts.required > 0 ? { key: 'required', count: requirementCounts.required, label: 'required', className: 'current-reroutes-card__meta-segment--required' } : null,
        requirementCounts.recommended > 0 ? { key: 'recommended', count: requirementCounts.recommended, label: 'recommended', className: 'current-reroutes-card__meta-segment--recommended' } : null,
        requirementCounts.fca > 0 ? { key: 'fca', count: requirementCounts.fca, label: 'FCA', className: 'current-reroutes-card__meta-segment--fca' } : null,
    ].filter(Boolean)

    const requirementSummary = requirementSegments.length > 0
        ? requirementSegments.map((segment, index) => (
            <span key={segment.key} className={`current-reroutes-card__meta-segment ${segment.className}`}>
                <strong>{segment.count}</strong> {segment.label}
                {index < requirementSegments.length - 1 && <span className="current-reroutes-card__meta-separator" aria-hidden="true" />}
            </span>
        ))
        : <span className="current-reroutes-card__meta-segment current-reroutes-card__meta-segment--required"><strong>{reroutes.length}</strong> advisories</span>

    if (reroutes.length === 0) return null

    return (
        <section ref={sectionRef} className="group-card current-reroutes-card">
            <button className="group-card__header current-reroutes-card__header" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title"><span className="group-card__icon">↪</span><span>FAA Route Advisories</span></h2>
                <span className="current-reroutes-card__meta current-reroutes-card__meta--summary">{requirementSummary}</span>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="current-reroutes-body">
                {tokens.length === 0 && <p className="current-reroutes-prompt">Search for an airport above to see its complete published reroute.</p>}
                {tokens.length > 0 && routeMatches.length === 0 && <p className="current-reroutes-prompt">No published route matches {tokens.join(' + ')}.</p>}
                {visibleReroutes.map(reroute => (
                    <details className="current-reroute" key={reroute.id} open={tokens.length > 0}>
                        <summary>
                            <span className={`current-reroute__requirement current-reroute__requirement--${reroute.requirement === 'FCA RQD' ? 'fca' : reroute.requirement === 'ROUTE RMD' ? 'recommended' : 'required'}`}>
                                <strong>{rerouteTypeLabel(reroute.requirement)}</strong>
                            </span>
                            <strong>{reroute.name}</strong>
                            <span className="current-reroute__area">{reroute.constrainedArea || 'Area not posted'}</span>
                        </summary>
                        <div className="current-reroute__detail">
                            <div className="current-reroute__meta">
                                <span>ADVZY {reroute.advisoryNumber}</span>
                                {reroute.validity && <span>{reroute.validity}</span>}
                            </div>
                            <dl className="current-reroute__fields">
                                {[
                                    ['includeTraffic', 'Traffic included'],
                                    ['facilitiesIncluded', 'Facilities'],
                                    ['flightStatus', 'Flight status'],
                                    ['reason', 'Reason'],
                                    ['probabilityOfExtension', 'Extension probability'],
                                    ['remarks', 'Remarks'],
                                    ['associatedRestrictions', 'Associated restrictions'],
                                ].map(([key, label]) => reroute.details?.[key] ? (
                                    <div key={key}><dt>{label}</dt><dd>{reroute.details[key]}</dd></div>
                                ) : null)}
                            </dl>
                            {tokens.length > 0 && routeMatches.filter(match => match.reroute.id === reroute.id).length > 0 && (
                                <div className="current-reroute__routes">
                                    <h3>Complete routes <span>{routeMatches.filter(match => match.reroute.id === reroute.id).length}</span></h3>
                                    {routeMatches.filter(match => match.reroute.id === reroute.id).map(({ route }, index) => (
                                        <div className="current-reroute__route" key={`${reroute.id}-route-${index}`}>
                                            <span><b>From:</b> {formatRerouteEndpoints(route.origins, route.originExclusions, 'All origins')}</span>
                                            <span><b>To:</b> {formatRerouteEndpoints(route.destinations, route.destinationExclusions, 'All destinations')}</span>
                                            <code>{route.route}</code>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {tokens.length === 0 && <pre>{reroute.rawText || 'Advisory detail unavailable.'}</pre>}
                            <a href={reroute.advisoryUrl} target="_blank" rel="noreferrer">Open FAA advisory</a>
                        </div>
                    </details>
                ))}
                <ScrollToTopAction onClick={() => scrollSectionToTop(sectionRef)} />
            </div>}
        </section>
    )
}

// ── Group Card ───────────────────────────────────────────────────────────────

function GroupCard({ group, tmis, autoExpand }) {
    const [collapsed, setCollapsed] = useState(true)
    const sectionRef = useRef(null)
    const style = GROUP_STYLES[group.color]
    const active = tmis.filter(t => t.status === 'ACTIVE')
    const proposed = tmis.filter(t => t.status === 'PROPOSED')
    // Sort: active first, then by aerodrome
    const sorted = [
        ...active.sort((a, b) => a.aerodrome.localeCompare(b.aerodrome)),
        ...proposed.sort((a, b) => a.aerodrome.localeCompare(b.aerodrome)),
    ]

    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    return (
        <section ref={sectionRef} className={`group-card ${group.color}`}>
            <button className={`group-card__header ${style.header}`} type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title">
                    <span className="group-card__icon">{group.icon}</span>
                    <span>{group.label}</span>
                </h2>
                <div className="group-card__counts">
                    {active.length > 0 && (
                        <span className="group-card__count group-card__count--active">
                            <strong>{active.length}</strong> active
                        </span>
                    )}
                    {active.length > 0 && proposed.length > 0 && (
                        <span className="group-card__separator" aria-hidden="true">·</span>
                    )}
                    {proposed.length > 0 && (
                        <span className="group-card__count group-card__count--proposed">
                            <strong>{proposed.length}</strong> proposed
                        </span>
                    )}
                </div>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="group-card__body">
                {sorted.map(tmi => (
                    <TMIRow key={tmi.id} tmi={tmi} style={style} />
                ))}
                <ScrollToTopAction onClick={() => scrollSectionToTop(sectionRef)} />
            </div>}
        </section>
    )
}

// ── Runway Closure Row ───────────────────────────────────────────────────────

function ClosureRow({ aerodrome, closures }) {
    return closures.map(c => (
        <div key={c.id} className="restriction-row closure-row">
            <span className={`status-pill ${c.state === 'ACTIVATED' ? 'status-pill--red' : 'status-pill--yellow'}`}>
                {c.state}
            </span>
            <span className="airport-code">{locationLabel(aerodrome)}</span>
            <span className="row-description">
                {c.source === 'OPS_PLAN'
                    ? <>{highlightAviationTerms(c.name)}</>
                    : c.runways.length > 0
                    ? <>Runway{c.runways.length > 1 ? 's' : ''} <strong className="text-white">{c.runways.join(' / ')}</strong> closed</>
                    : <><strong className="text-white">Airport</strong> closed</>
                }
                {c.source !== 'OPS_PLAN' && c.name && c.name !== 'Airport closed' ? ` — ${c.name.trim()}` : ''}
            </span>
            <TimeBubble tmi={c} />
        </div>
    ))
}

function OperationsPlan({ plan, autoExpand }) {
    const [collapsed, setCollapsed] = useState(true)
    const sectionRef = useRef(null)
    useEffect(() => {
        setCollapsed(!autoExpand)
    }, [autoExpand])

    if (!plan) return null

    return (
        <section ref={sectionRef} className="group-card ops-plan-card">
            <button className="group-card__header ops-plan-card__header" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
                <h2 className="group-card__title">
                    <span className="group-card__icon">◎</span><span>Operations Plan</span>
                </h2>
                <span className="ops-plan-card__meta">{plan.sections.length} sections</span>
                <span className="collapse-chevron" aria-hidden="true">{collapsed ? '+' : '−'}</span>
            </button>
            {!collapsed && <div className="ops-plan-body">
                <div className="ops-plan-title">{plan.title}</div>
                {Object.keys(plan.airportImpacts || {}).length > 0 && (
                    <div className="airport-impacts">
                        <div className="airport-impacts__heading">
                            <h3>Airport Impacts</h3>
                            <span>{Object.keys(plan.airportImpacts).length} airports</span>
                        </div>
                        {Object.entries(plan.airportImpacts).map(([airport, impacts]) => (
                            <section className="airport-impact" key={airport}>
                                <div className="airport-impact__airport">
                                    <strong>{airport}</strong>
                                    <span>{impacts.length} impact{impacts.length === 1 ? '' : 's'}</span>
                                </div>
                                <div className="airport-impact__items">
                                    {impacts.map(impact => (
                                        <div className="airport-impact__item" key={impact.id}>
                                            <span className={`impact-status impact-status--${impact.status.toLowerCase()}`}>{impact.status}</span>
                                            <span className="impact-kind">{impact.kind}</span>
                                            <span className="airport-impact__description">{highlightAviationTerms(impact.plainLanguage)}</span>
                                            {impact.endTime && <span className="airport-impact__end">Until {fmtTime(impact.endTime)}</span>}
                                        </div>
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
                {plan.sections.map(section => (
                    <section className="ops-plan-section" key={section.heading}>
                        <h3>{section.heading}</h3>
                        <div className="ops-plan-lines">
                            {section.lines.map((line, index) => <p key={`${section.heading}-${index}`}>{highlightAviationTerms(line)}</p>)}
                        </div>
                    </section>
                ))}
                <ScrollToTopAction onClick={() => scrollSectionToTop(sectionRef)} />
            </div>}
        </section>
    )
}

function SiteFooter({ connected, onOpenGuide, dayMode, onToggleDayMode, themeOverride, onResetTheme }) {
    return (
        <footer className="site-footer">
            <div className="site-footer__inner">
                <div className="site-footer__meta">
                    <div className={`connection ${connected ? 'connection--live' : 'connection--offline'}`}>
                        <span className="connection__dot" />
                        <span>{connected ? 'LIVE' : 'OFFLINE'}</span>
                    </div>
                </div>

                <div className="site-footer__links" aria-label="Footer links and data sources">
                    <span>© 2026 In Trail</span>
                    <span className="site-footer__separator">•</span>
                    <button className="site-footer__button" type="button" onClick={onOpenGuide}>User guide</button>
                    <span className="site-footer__separator">•</span>
                    <a href="https://github.com/MichaelDMcCracken/in-trail" target="_blank" rel="noreferrer">GitHub</a>
                    <span className="site-footer__separator">•</span>
                    <a href="mailto:michael.mccracken172+intrail@gmail.com?subject=In%20Trail%20Beta%20Feedback">Submit feedback</a>
                    <span className="site-footer__separator">•</span>
                    <button className="site-footer__button" type="button" onClick={onToggleDayMode} aria-label={dayMode ? 'Switch to night mode' : 'Switch to day mode'}>
                        {dayMode ? '🌙 Night' : '☀️ Day'}
                    </button>
                    {themeOverride !== null && (
                        <>
                            <span className="site-footer__separator">•</span>
                            <button className="site-footer__button" type="button" onClick={onResetTheme} aria-label="Switch to automatic day/night mode">
                                ⟳ Auto
                            </button>
                        </>
                    )}
                </div>
            </div>
        </footer>
    )
}

// ── App ──────────────────────────────────────────────────────────────────────

function isDaytime() {
    const hour = new Date().getHours()
    return hour >= 6 && hour < 20
}

export default function App() {
    const [showGuide, setShowGuide] = useState(false)
    const [connected, setConnected] = useState(false)
    const [lastUpdated, setLastUpdated] = useState(null)
    const [restrictions, setRestrictions] = useState([])
    const [runwayClosures, setRunwayClosures] = useState({})
    const [reroutes, setReroutes] = useState([])
    const [opsPlan, setOpsPlan] = useState(null)
    const [airportOperations, setAirportOperations] = useState(null)
    const [closuresCollapsed, setClosuresCollapsed] = useState(true)
    const [search, setSearch] = useState('')
    // themeOverride: 'day' | 'night' | null (null = follow time of day automatically)
    const [themeOverride, setThemeOverride] = useState(() => {
        // Migrate legacy 'theme' key written by a previous version
        const legacy = localStorage.getItem('theme')
        if (legacy) {
            localStorage.removeItem('theme')
            if (!localStorage.getItem('themeOverride') && (legacy === 'day' || legacy === 'night')) {
                localStorage.setItem('themeOverride', legacy)
            }
        }
        const stored = localStorage.getItem('themeOverride')
        return stored === 'day' || stored === 'night' ? stored : null
    })
    const [autoDay, setAutoDay] = useState(isDaytime)
    const wsRef = useRef(null)
    const searchRef = useRef(null)
    const closuresSectionRef = useRef(null)

    const dayMode = themeOverride !== null ? themeOverride === 'day' : autoDay

    // Apply theme to <html> whenever it changes
    useEffect(() => {
        if (dayMode) {
            document.documentElement.setAttribute('data-theme', 'day')
        } else {
            document.documentElement.removeAttribute('data-theme')
        }
    }, [dayMode])

    // Re-check time-of-day every minute so the theme switches automatically
    useEffect(() => {
        const id = setInterval(() => setAutoDay(isDaytime()), 60_000)
        return () => clearInterval(id)
    }, [])

    function handleToggleTheme() {
        // Pressing the button toggles to the opposite of the current dayMode
        // and locks that choice as an override
        const next = dayMode ? 'night' : 'day'
        setThemeOverride(next)
        localStorage.setItem('themeOverride', next)
    }

    function handleResetTheme() {
        setThemeOverride(null)
        localStorage.removeItem('themeOverride')
    }

    useEffect(() => {
        function connect() {
            const backendUrl = import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:3001`
            const wsUrl = backendUrl.replace(/^http/, 'ws')
            const ws = new WebSocket(wsUrl)
            wsRef.current = ws
            ws.onopen = () => setConnected(true)
            ws.onclose = () => {
                setConnected(false)
                setTimeout(connect, 3000)
            }
            ws.onmessage = (e) => {
                const { event, data } = JSON.parse(e.data)
                if (event === 'snapshot' || event === 'update') {
                    setConnected(data.connected)
                    setLastUpdated(data.lastUpdated)
                    setRestrictions(data.restrictions || [])
                    setRunwayClosures(data.runwayClosures || {})
                    setReroutes(data.reroutes || [])
                    setOpsPlan(data.opsPlan || null)
                    setAirportOperations(data.airportOperations || null)
                } else if (event === 'status') {
                    setConnected(data.connected)
                }
            }
        }
        connect()
        return () => wsRef.current?.close()
    }, [])

    useEffect(() => {
        function focusSearch(e) {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                searchRef.current?.focus()
            }
        }
        window.addEventListener('keydown', focusSearch)
        return () => window.removeEventListener('keydown', focusSearch)
    }, [])

    // Filter by search
    const q = search.replace(/,/g, ' ').trim().toUpperCase()
    const searchTokens = q.split(/\s+/).filter(Boolean)
    const filtered = useMemo(() => {
        const displayedRestrictions = restrictions.filter(t => DISPLAYED_RESTRICTION_TYPES.has(t.type))
        if (searchTokens.length === 0) return displayedRestrictions
        return displayedRestrictions.filter(t =>
            searchTokens.some(token => [t.aerodrome, t.controlledElement, t.nasElement, t.name, t.providingFacility]
                .filter(Boolean)
                .some(value => value.toUpperCase().includes(token)))
        )
    }, [restrictions, searchTokens])

    const filteredClosures = useMemo(() => {
        if (!q) return runwayClosures
        return Object.fromEntries(
            Object.entries(runwayClosures).filter(([apt]) => apt.includes(q) || apt.replace(/^K/, '').includes(q))
        )
    }, [runwayClosures, q])

    // Build grouped data
    const groups = useMemo(() =>
        GROUPS.map(g => ({
            ...g,
            tmis: filtered.filter(t => g.matches ? g.matches(t) : g.types.includes(t.type)),
        })).filter(g => g.tmis.length > 0)
    , [filtered])

    // Runway closures temporarily hidden from the UI.
    const hasClosures = false
    const hasSearch = q.length > 0

    useEffect(() => {
        setClosuresCollapsed(!hasSearch)
    }, [hasSearch])
    const totalActive = restrictions.filter(t => t.status === 'ACTIVE').length
    const filteredReroutes = reroutes.filter(reroute => !q || [reroute.name, reroute.requirement, reroute.constrainedArea, reroute.rawText]
        .filter(Boolean)
        .some(value => value.toUpperCase().includes(q)))
    const isEmpty = groups.length === 0 && filteredReroutes.length === 0 && !hasClosures

    return (
        <div className="app-shell">
            {/* Header */}
            <header className="topbar">
                <div className="topbar__inner">
                    <div className="brand-lockup">
                        <div className="brand-mark">✈</div>
                        <div>
                            <h1>In Trail</h1>
                            <p>National airspace watch</p>
                        </div>
                    </div>
                    <div className="topbar__meta">
                        {lastUpdated && (
                            <div className="last-update"><span>LAST SYNC</span><strong>{fmtTime(lastUpdated)}</strong></div>
                        )}
                        <div className={`connection ${connected ? 'connection--live' : 'connection--offline'}`}>
                            <span className="connection__dot" />
                            <span>
                                {connected ? 'LIVE' : 'OFFLINE'}
                            </span>
                        </div>
                    </div>
                </div>
            </header>

            {showGuide ? <Guide onBack={() => setShowGuide(false)} /> : <main className="dashboard">
                <section className="intro">
                    <div>
                        <p className="eyebrow">FAA SWIM / TFDM FEED</p>
                        <h2>Airspace, at a glance.</h2>
                        <p className="intro__copy">Active and upcoming traffic management restrictions across the national airspace system.</p>
                    </div>
                    <div className="intro__signal"><span /> Monitoring live feed</div>
                </section>
                {/* Summary bar */}
                {(restrictions.length > 0 || reroutes.length > 0 || hasClosures) && (
                    <div className="summary-grid">
                        <div className="stat-card">
                            <span className="stat-card__label">Active TMIs</span>
                            <strong>{totalActive}</strong>
                            <span className="stat-card__hint">traffic measures</span>
                        </div>
                        {reroutes.length > 0 && (
                            <div className="stat-card stat-card--reroute">
                                <span className="stat-card__label">Mandated reroutes</span>
                                <strong>{reroutes.length}</strong>
                                <span className="stat-card__hint">current advisories</span>
                            </div>
                        )}
                        {hasClosures && (
                            <div className="stat-card stat-card--alert">
                                <span className="stat-card__label">Runway closures</span>
                                <strong>{Object.values(filteredClosures).flat().length}</strong>
                                <span className="stat-card__hint">requiring attention</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Search */}
                <label className="search-box">
                    <span className="search-box__icon">⌕</span>
                    <input ref={searchRef} aria-label="Search airport, fix, or facility" type="text" placeholder="Search airport, fix, or facility" value={search} onChange={e => setSearch(e.target.value)} />
                    <span className="search-box__key">⌘ K</span>
                </label>

                <AirportDelays operations={airportOperations} autoExpand={hasSearch} query={q} />

                {/* Empty state */}
                {isEmpty && (
                    <div className="empty-state">
                        <div className="empty-state__icon">
                            {!connected ? '×' : restrictions.length === 0 ? '◌' : hasSearch ? '✈️' : '◌'}
                        </div>
                        <p>
                            {!connected
                                ? 'Connecting to FAA SWIM…'
                                : restrictions.length === 0
                                    ? 'Receiving data from FAA SWIM…'
                                    : hasSearch
                                        ? <>No current delays or initiatives at <strong>{lookupAirportName(q) || q}</strong> — {ALL_CLEAR_QUIPS[q.charCodeAt(0) % ALL_CLEAR_QUIPS.length]} ☀️</>
                                        : 'No active restrictions match your filter.'
                            }
                        </p>
                    </div>
                )}

                {/* Restriction groups */}
                {groups.map(g => (
                    <GroupCard key={g.key} group={g} tmis={g.tmis} autoExpand={hasSearch} />
                ))}

                <CurrentReroutes reroutes={reroutes} autoExpand={hasSearch} query={q} />

                {/* Runway closures */}
                {hasClosures && (
                    <section ref={closuresSectionRef} className="group-card closures-card">
                        <button className="group-card__header closures-card__header" type="button" aria-expanded={!closuresCollapsed} onClick={() => setClosuresCollapsed(value => !value)}>
                            <h2 className="group-card__title">
                                <span className="group-card__icon">🚧</span><span>Runway closures</span>
                            </h2>
                            <span className="collapse-chevron" aria-hidden="true">{closuresCollapsed ? '+' : '−'}</span>
                        </button>
                        {!closuresCollapsed && <div className="group-card__body">
                            {Object.entries(filteredClosures).map(([apt, closures]) =>
                                closures.length > 0
                                    ? <ClosureRow key={apt} aerodrome={apt} closures={closures} />
                                    : null
                            )}
                            <ScrollToTopAction onClick={() => scrollSectionToTop(closuresSectionRef)} />
                        </div>}
                    </section>
                )}
            </main>}

            <SiteFooter connected={connected} onOpenGuide={() => setShowGuide(true)} dayMode={dayMode} onToggleDayMode={handleToggleTheme} themeOverride={themeOverride} onResetTheme={handleResetTheme} />
        </div>
    )
}
